/**
 * pi-ntfy — subscribe to an ntfy topic and turn notifications into agent turns.
 *
 * Design constraints:
 *  - never break pi: every handler swallows its own errors
 *  - never block startup: the subscription runs detached from `session_start`
 *  - never replay a backlog: `since=none` + a durable processed-id set
 *  - never kill in-flight work: idle -> new turn, streaming -> steer/followUp
 *  - **never nag**: an unconfigured extension is silently inert. Not every session wants an
 *    inbound alert channel, so "no topic" is a normal state, not a warning.
 *  - **configurable at runtime**: a running session — or the agent itself, via the
 *    `ntfy_configure` tool — can turn alerts on without restarting pi.
 */

import os from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { parseConfig, type EnvLike, type NtfyConfig } from "./config.js";
import {
	configFilePath,
	describeSecret,
	isKnownKey,
	readConfigFile,
	writeConfigFile,
	type ConfigFileValues,
	type LoadedConfigFile,
} from "./configFile.js";
import { evaluate } from "./filter.js";
import { createLogger, type Logger } from "./log.js";
import { publish, subscribe, type NtfyMessage, type SubscribeStats } from "./ntfy.js";
import { appendCapped, loadIds, makeIdSet, saveIds } from "./state.js";
import { buildTemplateVars, renderTemplate } from "./template.js";

const STATUS_KEY = "ntfy";
const CUSTOM_TYPE = "ntfy";

interface SessionState {
	ctx: ExtensionContext;
	logger: Logger;
	config: NtfyConfig;
	configFile: LoadedConfigFile;
	ids: string[];
	seen: Set<string>;
	delivered: number;
	lastError: string | undefined;
	connected: boolean;
	controller: AbortController | undefined;
	stats: SubscribeStats | undefined;
	/** Bumped on every (re)start so a stale loop cannot write into the new one. */
	generation: number;
}

let state: SessionState | undefined;
let activePi: ExtensionAPI | undefined;

const homeDir = (): string => os.homedir();

/** Set the footer status. `value` is the part after `ntfy: `. */
function setStatus(ctx: ExtensionContext, value: string): void {
	try {
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, `${STATUS_KEY}: ${value}`);
		}
	} catch {
		// status is cosmetic; never let it break anything
	}
}

function clearStatus(ctx: ExtensionContext): void {
	try {
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	} catch {
		// ignore
	}
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error"): void {
	try {
		ctx.ui.notify(text, level);
	} catch {
		// ignore
	}
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * Read both configuration sources and build the effective config.
 *
 * Priority is env > config file > defaults, so an exported `PI_NTFY_TOPIC` still wins for
 * one-off/CI runs while the file serves the "configure me once, from inside a session" case.
 */
function resolveConfig(): { config: NtfyConfig; configFile: LoadedConfigFile } {
	const filePath = configFilePath(process.env, homeDir());
	const configFile = readConfigFile(filePath);
	const config = parseConfig({
		env: process.env as EnvLike,
		fileEnv: configFile.env,
		homeDir: homeDir(),
	});
	return { config, configFile };
}

/** Start (or restart) the background subscriber. Never awaited by the caller. */
function startSubscriber(): void {
	const current = state;
	if (current === undefined || !current.config.enabled) {
		return;
	}

	current.controller?.abort();
	const controller = new AbortController();
	current.controller = controller;
	current.generation += 1;
	const generation = current.generation;

	const { config, logger, ctx } = current;
	setStatus(ctx, "connecting…");

	void subscribe({
		server: config.server,
		topic: config.topic,
		token: config.token,
		signal: controller.signal,
		onOpen: () => {
			if (generation !== state?.generation) {
				return;
			}
			current.connected = true;
			current.lastError = undefined;
			setStatus(ctx, "connected");
			if (!config.quiet) {
				notify(ctx, `pi-ntfy connected to ${config.server}/${config.topic}`, "info");
			}
		},
		onError: (error, attempt, delayMs) => {
			if (generation !== state?.generation) {
				return;
			}
			current.connected = false;
			const message = describeError(error);
			current.lastError = message;
			if (delayMs > 0) {
				logger.warn(`subscribe failed (attempt ${attempt}): ${message}; retrying in ${delayMs}ms`);
				setStatus(ctx, `reconnecting in ${Math.round(delayMs / 1000)}s`);
			} else {
				logger.error(`subscribe gave up after ${attempt} attempts: ${message}`);
				setStatus(ctx, `failed (${message})`);
				if (!config.quiet) {
					notify(ctx, `pi-ntfy gave up reconnecting: ${message}`, "error");
				}
			}
		},
		onMessage: (message) => {
			if (generation !== state?.generation) {
				return;
			}
			handleMessage(current, message);
		},
		maxRetries: config.maxRetries,
	})
		.then((stats) => {
			if (generation === state?.generation) {
				current.stats = stats;
			}
		})
		.catch((error: unknown) => {
			logger.error(`subscriber crashed: ${describeError(error)}`);
		});
}

function stopSubscriber(): void {
	if (state !== undefined) {
		state.controller?.abort();
		state.controller = undefined;
		state.connected = false;
		state.generation += 1;
	}
}

/** Reload the processed-id set (the state file can change with the config). */
function reloadIds(current: SessionState): void {
	const loaded = loadIds(current.config.stateFile);
	if (loaded.error !== undefined) {
		current.logger.warn(`could not read ${current.config.stateFile}: ${loaded.error}`);
	}
	current.ids = loaded.ids;
	current.seen = makeIdSet(loaded.ids);
}

/**
 * Re-resolve the config and bring the subscriber in line with it: stop first, then start
 * only if the new config says so. This is what makes `/ntfy enable` work without a restart.
 */
function applyConfig(current: SessionState): void {
	stopSubscriber();

	const { config, configFile } = resolveConfig();
	const previousStateFile = current.config.stateFile;

	if (!config.configured) {
		current.config = config;
		current.configFile = configFile;
		// Nobody asked for this: leave no footer trace, just a debug line.
		current.logger.debug(config.reason ?? "pi-ntfy is not configured");
		clearStatus(current.ctx);
		return;
	}

	if (!config.enabled) {
		current.config = config;
		current.configFile = configFile;
		setStatus(current.ctx, "configured but disabled");
		for (const error of config.errors) {
			current.logger.warn(error);
		}
		return;
	}

	current.config = config;
	current.configFile = configFile;
	if (config.stateFile !== previousStateFile) {
		reloadIds(current);
	}
	for (const warning of config.warnings) {
		current.logger.warn(warning);
	}
	startSubscriber();
}

function handleMessage(current: SessionState, message: NtfyMessage): void {
	const { config, logger } = current;

	const decision = evaluate(
		{
			event: "message",
			id: message.id,
			time: message.time,
			topic: message.topic,
			title: message.title,
			message: message.message,
			priority: message.priority,
			tags: message.tags,
			click: message.click,
		},
		{
			minPriority: config.minPriority,
			tagAllow: config.tagAllow,
			isDuplicate: (id) => current.seen.has(id),
		},
	);

	if (!decision.deliver) {
		logger.debug(`dropped message ${message.id}: ${decision.reason}`);
		return;
	}

	// Mark processed *before* delivery: a duplicate is safer than a re-delivery loop.
	current.ids = appendCapped(current.ids, message.id);
	current.seen = makeIdSet(current.ids);
	const saved = saveIds(config.stateFile, current.ids);
	if (!saved.ok) {
		logger.warn(`could not persist processed ids: ${saved.error ?? "unknown error"}`);
	}

	const text = renderTemplate(config.promptTemplate, buildTemplateVars(message));
	deliver(current, text, message);
}

function deliver(current: SessionState, text: string, message: NtfyMessage): void {
	const { config, logger, ctx } = current;
	const custom = {
		customType: CUSTOM_TYPE,
		content: text,
		display: true,
		details: {
			id: message.id,
			topic: message.topic,
			title: message.title,
			priority: message.priority,
			tags: message.tags,
		},
	};

	try {
		if (ctx.isIdle()) {
			if (config.idleDelivery === "user") {
				piSendUserMessage(text, config.streamingDelivery);
			} else {
				piSendCustom(custom, undefined);
			}
		} else {
			piSendCustom(custom, config.streamingDelivery);
		}
		current.delivered += 1;
		logger.info(`delivered ntfy ${message.id} (${message.title || "no title"})`);
	} catch (error) {
		const reason = describeError(error);
		current.lastError = reason;
		logger.error(`delivery failed: ${reason}`);
		notify(ctx, `pi-ntfy delivery failed: ${reason}`, "error");
	}
}

type CustomMessage = {
	customType: string;
	content: string;
	display: boolean;
	details: Record<string, unknown>;
};

function piSendUserMessage(text: string, deliverAs: "steer" | "followUp" | undefined): void {
	if (activePi === undefined) {
		throw new Error("pi API not initialised");
	}
	// `deliverAs` is always passed, even when the agent looks idle. pi's extension
	// action never throws synchronously (it attaches its own .catch), so a
	// try/catch around it cannot observe the "agent became busy between the
	// isIdle() check and the call" race — the previous fallback branch was dead
	// code. Passing `deliverAs` removes the race at the source: when idle, pi
	// ignores it and runs the prompt immediately; when the race is lost, the
	// message is queued as steer/followUp instead of being rejected.
	activePi.sendUserMessage(text, deliverAs === undefined ? undefined : { deliverAs });
}

function piSendCustom(message: CustomMessage, deliverAs: "steer" | "followUp" | undefined): void {
	if (activePi === undefined) {
		throw new Error("pi API not initialised");
	}
	if (deliverAs === undefined) {
		activePi.sendMessage(message, { triggerTurn: true });
		return;
	}
	activePi.sendMessage(message, { deliverAs, triggerTurn: true });
}

function statusLines(current: SessionState): string[] {
	const { config, stats } = current;
	return [
		`configured: ${config.configured ? `yes (from ${config.source})` : "no"}`,
		`config file:${current.configFile.exists ? "" : " (absent)"} ${current.configFile.path}`,
		`topic:      ${config.configured ? config.topic : "-"}`,
		`server:     ${config.server}`,
		`auth:       ${describeSecret(config.token)}`,
		`connected:  ${current.connected ? "yes" : "no"}`,
		`delivered:  ${current.delivered}`,
		`remembered: ${current.ids.length} message ids`,
		`retries:    ${config.maxRetries === null ? "unlimited" : String(config.maxRetries)}`,
		`streams:    ${stats?.connections ?? 0} opened, ${stats?.failures ?? 0} failures`,
		`last error: ${current.lastError ?? "-"}`,
	];
}

/**
 * Coerce a `/ntfy set` value into the JSON type the config file expects.
 * Unknown keys are rejected rather than written, so a typo cannot silently do nothing.
 */
export function coerceFileValue(key: string, raw: string): ConfigFileValues | undefined {
	const text = raw.trim();
	switch (key) {
		case "topic":
		case "server":
		case "token":
		case "promptTemplate":
		case "stateFile":
			return { [key]: text } as ConfigFileValues;
		case "minPriority":
		case "maxRetries": {
			const n = Number(text);
			return Number.isFinite(n) ? ({ [key]: n } as ConfigFileValues) : undefined;
		}
		case "quiet":
			return { quiet: text === "1" || text.toLowerCase() === "true" };
		case "enabled":
			return { enabled: text === "1" || text.toLowerCase() === "true" };
		case "tagAllow":
			return {
				tagAllow: text
					.split(",")
					.map((t) => t.trim())
					.filter((t) => t.length > 0),
			};
		case "idleDelivery":
		case "streamingDelivery":
			return { [key]: text } as ConfigFileValues;
		default:
			return undefined;
	}
}

const SETTABLE_KEYS =
	"topic | server | token | minPriority | tagAllow | idleDelivery | streamingDelivery | maxRetries | promptTemplate | stateFile | quiet | enabled";

/** Apply a patch to the config file and bring the live subscriber in line with it. */
function patchConfig(patch: ConfigFileValues): { ok: boolean; message: string } {
	const current = state;
	const filePath = current?.configFile.path ?? configFilePath(process.env, homeDir());
	const written = writeConfigFile(filePath, patch);
	if (!written.ok) {
		return { ok: false, message: `could not write ${filePath}: ${written.error ?? "unknown error"}` };
	}
	if (current === undefined) {
		return { ok: true, message: `wrote ${filePath}; takes effect in the next session` };
	}
	applyConfig(current);
	const { config } = current;
	if (!config.configured) {
		return { ok: true, message: `wrote ${filePath}; still no topic, so nothing is listening` };
	}
	if (!config.enabled) {
		return {
			ok: true,
			message: `saved to ${filePath}, but it is not usable: ${config.errors.join("; ") || "disabled"}`,
		};
	}
	return { ok: true, message: `saved to ${filePath}; now listening on ${config.server}/${config.topic}` };
}

function configSnapshot(): string {
	const current = state;
	if (current === undefined) {
		const { config, configFile } = resolveConfig();
		return JSON.stringify(
			{
				configured: config.configured,
				enabled: config.enabled,
				source: config.source,
				topic: config.configured ? config.topic : null,
				server: config.server,
				token: describeSecret(config.token),
				configFile: configFile.path,
				configFileExists: configFile.exists,
				configFileError: configFile.error ?? null,
			},
			null,
			2,
		);
	}
	const { config, configFile } = current;
	return JSON.stringify(
		{
			configured: config.configured,
			enabled: config.enabled,
			source: config.source,
			topic: config.configured ? config.topic : null,
			server: config.server,
			token: describeSecret(config.token),
			minPriority: config.minPriority,
			tagAllow: config.tagAllow,
			connected: current.connected,
			delivered: current.delivered,
			rememberedIds: current.ids.length,
			lastError: current.lastError ?? null,
			configFile: configFile.path,
			configFileExists: configFile.exists,
			configFileError: configFile.error ?? null,
			warnings: config.warnings,
			errors: config.errors,
		},
		null,
		2,
	);
}

function registerConfigureTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ntfy_configure",
		label: "Configure ntfy alerts",
		description:
			"Read or change pi-ntfy's settings so external ntfy notifications can wake this agent. " +
			"Use action 'get' to inspect the effective configuration, or 'set' to enable/point it at a topic. " +
			"Changes are persisted to the pi-ntfy config file and take effect immediately, without restarting pi. " +
			"The token is never returned in clear text.",
		promptSnippet: "Inspect or change pi-ntfy alert settings (topic, server, filters)",
		promptGuidelines: [
			"Use ntfy_configure when the user asks to receive external alerts, or to enable, disable, or repoint pi-ntfy.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("get"), Type.Literal("set")], {
				description: "'get' returns the effective configuration; 'set' applies the given fields.",
			}),
			topic: Type.Optional(Type.String({ description: "ntfy topic to subscribe to (1-64 chars of A-Za-z0-9_-)" })),
			server: Type.Optional(Type.String({ description: "Base URL of the ntfy server" })),
			token: Type.Optional(
				Type.String({ description: "Bearer token for a protected topic; prefer '$ENV_VAR' over a literal" }),
			),
			minPriority: Type.Optional(Type.Number({ description: "Drop messages below this ntfy priority (1-5)" })),
			tagAllow: Type.Optional(
				Type.Array(Type.String(), { description: "Only deliver messages carrying one of these tags" }),
			),
			enabled: Type.Optional(Type.Boolean({ description: "false turns the subscription off" })),
		}),
		async execute(_toolCallId, params) {
			try {
				if (params.action === "get") {
					return { content: [{ type: "text", text: configSnapshot() }], details: {} };
				}

				const patch: ConfigFileValues = {};
				if (params.topic !== undefined) {
					patch.topic = params.topic;
				}
				if (params.server !== undefined) {
					patch.server = params.server;
				}
				if (params.token !== undefined) {
					patch.token = params.token;
				}
				if (params.minPriority !== undefined) {
					patch.minPriority = params.minPriority;
				}
				if (params.tagAllow !== undefined) {
					patch.tagAllow = params.tagAllow;
				}
				if (params.enabled !== undefined) {
					patch.enabled = params.enabled;
				}
				if (Object.keys(patch).length === 0) {
					return {
						content: [{ type: "text", text: "Nothing to set: pass at least one field." }],
						details: {},
						isError: true,
					};
				}
				if (patch.enabled === true) {
					// Enabling without a topic is a no-op the caller should hear about.
					const preview = resolveConfig().config;
					if (!preview.configured && patch.topic === undefined) {
						return {
							content: [
								{
									type: "text",
									text: "No topic is configured yet; pass topic as well, or the subscription has nothing to listen to.",
								},
							],
							details: {},
							isError: true,
						};
					}
				}

				const result = patchConfig(patch);
				const text = `${result.message}\n\n${configSnapshot()}`;
				return { content: [{ type: "text", text }], details: {}, isError: !result.ok };
			} catch (error) {
				return {
					content: [{ type: "text", text: `ntfy_configure failed: ${describeError(error)}` }],
					details: {},
					isError: true,
				};
			}
		},
	});
}

export default function (pi: ExtensionAPI): void {
	activePi = pi;

	// Registered at load time, not inside session_start: the agent has to be able to
	// configure alerts even in a session that started with nothing configured.
	registerConfigureTool(pi);

	pi.on("session_start", async (_event, ctx) => {
		try {
			stopSubscriber();

			const { config, configFile } = resolveConfig();
			const logger = createLogger("info");

			const next: SessionState = {
				ctx,
				logger,
				config,
				configFile,
				ids: [],
				seen: new Set<string>(),
				delivered: 0,
				lastError: undefined,
				connected: false,
				controller: undefined,
				stats: undefined,
				generation: 0,
			};
			state = next;

			if (configFile.error !== undefined) {
				logger.warn(`ignoring ${configFile.path}: ${configFile.error}`);
			}

			// Nobody asked for alerts: stay completely quiet (no status, no notify, no request).
			if (!config.configured || configFile.disabled) {
				if (configFile.disabled) {
					logger.debug("pi-ntfy is disabled by the config file");
				} else {
					logger.debug(config.reason ?? "pi-ntfy is not configured");
				}
				clearStatus(ctx);
				return;
			}

			if (!config.enabled) {
				setStatus(ctx, "configured but disabled");
				for (const error of config.errors) {
					logger.warn(error);
				}
				notify(ctx, `pi-ntfy is not usable: ${config.errors.join("; ")}`, "warning");
				return;
			}

			reloadIds(next);
			for (const warning of config.warnings) {
				logger.warn(warning);
				notify(ctx, `pi-ntfy: ${warning}`, "warning");
			}

			startSubscriber();
		} catch (error) {
			setStatus(ctx, "error");
			notify(ctx, `pi-ntfy failed to start: ${describeError(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		stopSubscriber();
		if (state !== undefined) {
			clearStatus(state.ctx);
		}
	});

	pi.registerCommand("ntfy", {
		description:
			"pi-ntfy control: status | enable <topic> | disable | set <key> <value> | reload | test [msg] | reconnect | ids",
		handler: async (args, ctx) => {
			try {
				const sub = args.trim().split(/\s+/u)[0] ?? "";
				const rest = args.trim().slice(sub.length).trim();

				if (sub === "") {
					const current = state;
					notify(
						ctx,
						current === undefined ? configSnapshot() : statusLines(current).join("\n"),
						"info",
					);
					return;
				}

				if (sub === "enable") {
					if (rest.length === 0) {
						// Enabling without naming a topic is fine if one is already configured.
						const existing = resolveConfig().config;
						if (!existing.configured) {
							notify(ctx, "usage: /ntfy enable <topic>", "warning");
							return;
						}
						notify(ctx, patchConfig({ enabled: true }).message, "info");
						return;
					}
					const result = patchConfig({ topic: rest, enabled: true });
					notify(ctx, result.message, result.ok ? "info" : "error");
					return;
				}

				if (sub === "disable") {
					const result = patchConfig({ enabled: false });
					notify(ctx, result.message, result.ok ? "info" : "error");
					return;
				}

				if (sub === "reload") {
					const current = state;
					if (current === undefined) {
						notify(ctx, "pi-ntfy: no active session", "warning");
						return;
					}
					applyConfig(current);
					notify(ctx, statusLines(current).join("\n"), "info");
					return;
				}

				if (sub === "set") {
					const parts = rest.split(/\s+/u);
					const key = parts[0] ?? "";
					const value = parts.slice(1).join(" ");
					if (key.length === 0 || value.length === 0) {
						notify(ctx, `usage: /ntfy set <key> <value>\nkeys: ${SETTABLE_KEYS}`, "warning");
						return;
					}
					if (!isKnownKey(key)) {
						notify(ctx, `unknown key "${key}"\nkeys: ${SETTABLE_KEYS}`, "warning");
						return;
					}
					const patch = coerceFileValue(key, value);
					if (patch === undefined) {
						notify(ctx, `cannot parse a value for "${key}" from ${JSON.stringify(value)}`, "warning");
						return;
					}
					const result = patchConfig(patch);
					notify(ctx, result.message, result.ok ? "info" : "error");
					return;
				}

				const current = state;
				if (current === undefined) {
					notify(ctx, "pi-ntfy: no active session", "warning");
					return;
				}

				if (sub === "ids") {
					notify(ctx, `pi-ntfy remembers ${current.ids.length} processed message ids`, "info");
					return;
				}

				if (sub === "reconnect") {
					if (!current.config.enabled) {
						notify(ctx, "pi-ntfy is not configured; run /ntfy enable <topic> first", "warning");
						return;
					}
					startSubscriber();
					notify(ctx, "pi-ntfy reconnecting…", "info");
					return;
				}

				if (sub === "test") {
					if (!current.config.enabled) {
						notify(ctx, "pi-ntfy is not configured; run /ntfy enable <topic> first", "warning");
						return;
					}
					const body = rest.length > 0 ? rest : `test from pi-ntfy at ${new Date().toISOString()}`;
					const result = await publish({
						server: current.config.server,
						topic: current.config.topic,
						token: current.config.token,
						message: body,
						title: "pi-ntfy test",
						priority: 3,
						tags: ["test_tube"],
					});
					if (result.ok) {
						notify(ctx, `published test message to ${current.config.topic} (HTTP ${result.status})`, "info");
					} else {
						notify(ctx, `publish failed: ${result.error ?? "unknown error"}`, "error");
					}
					return;
				}

				notify(
					ctx,
					`unknown subcommand "${sub}"; try: status | enable <topic> | disable | set <key> <value> | reload | test [msg] | reconnect | ids`,
					"warning",
				);
			} catch (error) {
				notify(ctx, `pi-ntfy command failed: ${describeError(error)}`, "error");
			}
		},
	});
}
