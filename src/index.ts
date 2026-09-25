/**
 * pi-ntfy — subscribe to an ntfy topic and turn notifications into agent turns.
 *
 * Design constraints (see SPEC §2):
 *  - never break pi: every handler swallows its own errors
 *  - never block startup: the subscription runs detached from `session_start`
 *  - never replay a backlog: `since=none` + a durable processed-id set
 *  - never kill in-flight work: idle -> new turn, streaming -> steer/followUp
 */

import os from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { parseConfig, type NtfyConfig } from "./config.js";
import { evaluate } from "./filter.js";
import { createLogger, type Logger } from "./log.js";
import { publish, subscribe, type NtfyMessage, type SubscribeStats } from "./ntfy.js";
import { appendCapped, loadIds, makeIdSet, saveIds } from "./state.js";
import { buildTemplateVars, renderTemplate } from "./template.js";

const STATUS_KEY = "ntfy";
const CUSTOM_TYPE = "ntfy";

interface Runtime {
	ctx: ExtensionContext;
	config: NtfyConfig;
	logger: Logger;
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

let runtime: Runtime | undefined;

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

/** Start (or restart) the background subscriber. Never awaited by the caller. */
function startSubscriber(): void {
	const current = runtime;
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
			if (generation !== runtime?.generation) {
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
			if (generation !== runtime?.generation) {
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
			if (generation !== runtime?.generation) {
				return;
			}
			handleMessage(current, message);
		},
		maxRetries: config.maxRetries,
	})
		.then((stats) => {
			if (generation === runtime?.generation) {
				current.stats = stats;
			}
		})
		.catch((error: unknown) => {
			logger.error(`subscriber crashed: ${describeError(error)}`);
		});
}

function handleMessage(current: Runtime, message: NtfyMessage): void {
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

function deliver(current: Runtime, text: string, message: NtfyMessage): void {
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

// The pi API surface is captured in `activePi` so the helpers below stay tiny.
let activePi: ExtensionAPI | undefined;

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

function stopSubscriber(): void {
	if (runtime !== undefined) {
		runtime.controller?.abort();
		runtime.controller = undefined;
		runtime.connected = false;
		runtime.generation += 1;
	}
}

function statusLines(current: Runtime): string[] {
	const { config, stats } = current;
	return [
		`topic:      ${config.topic}`,
		`server:     ${config.server}`,
		`auth:       ${config.token === undefined ? "none" : "bearer token"}`,
		`connected:  ${current.connected ? "yes" : "no"}`,
		`delivered:  ${current.delivered}`,
		`remembered: ${current.ids.length} message ids`,
		`retries:    ${config.maxRetries === null ? "unlimited" : String(config.maxRetries)}`,
		`streams:    ${stats?.connections ?? 0} opened, ${stats?.failures ?? 0} failures`,
		`last error: ${current.lastError ?? "-"}`,
	];
}

export default function (pi: ExtensionAPI): void {
	activePi = pi;

	pi.on("session_start", async (_event, ctx) => {
		try {
			stopSubscriber();

			const config = parseConfig({ env: process.env, homeDir: os.homedir() });
			const logger = createLogger("info");

			if (!config.enabled) {
				runtime = undefined;
				setStatus(ctx, "disabled");
				for (const error of config.errors) {
					logger.warn(error);
				}
				notify(ctx, `pi-ntfy disabled: ${config.errors.join("; ")}`, "warning");
				return;
			}

			const loaded = loadIds(config.stateFile);
			if (loaded.error !== undefined) {
				logger.warn(`could not read ${config.stateFile}: ${loaded.error}`);
			}

			runtime = {
				ctx,
				config,
				logger,
				ids: loaded.ids,
				seen: makeIdSet(loaded.ids),
				delivered: 0,
				lastError: undefined,
				connected: false,
				controller: undefined,
				stats: undefined,
				generation: 0,
			};

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
		if (runtime !== undefined) {
			setStatus(runtime.ctx, "stopped");
		}
	});

	pi.registerCommand("ntfy", {
		description:
			"pi-ntfy control: no args = status, 'test [message]' = publish a test message, 'reconnect' = restart the stream, 'ids' = remembered message count",
		handler: async (args, ctx) => {
			try {
				const current = runtime;
				const sub = args.trim().split(/\s+/u)[0] ?? "";

				if (current === undefined) {
					const config = parseConfig({ env: process.env, homeDir: os.homedir() });
					const why = config.errors.length > 0 ? config.errors.join("; ") : "session has not started yet";
					notify(ctx, `pi-ntfy is not running: ${why}`, "warning");
					return;
				}

				if (sub === "" || sub === "status") {
					notify(ctx, statusLines(current).join("\n"), "info");
					return;
				}

				if (sub === "ids") {
					notify(ctx, `pi-ntfy remembers ${current.ids.length} processed message ids`, "info");
					return;
				}

				if (sub === "reconnect") {
					startSubscriber();
					notify(ctx, "pi-ntfy reconnecting…", "info");
					return;
				}

				if (sub === "test") {
					const rest = args.trim().slice(sub.length).trim();
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

				notify(ctx, `unknown subcommand "${sub}"; try: status | test [msg] | reconnect | ids`, "warning");
			} catch (error) {
				notify(ctx, `pi-ntfy command failed: ${describeError(error)}`, "error");
			}
		},
	});
}
