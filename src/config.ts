/**
 * Environment-variable configuration parsing.
 *
 * Rules that matter:
 *  - absent / malformed input must never throw — it degrades, records a warning,
 *    and (for the two values without which the extension is meaningless) disables it.
 *  - the whole thing is a pure function of (env, homeDir) so it is trivially testable.
 */

import path from "node:path";

export const DEFAULT_SERVER = "https://ntfy.sh";
export const DEFAULT_MIN_PRIORITY = 1;
/** ntfy's own default priority for a message that omits the field. */
export const NTFY_DEFAULT_PRIORITY = 3;
export const DEFAULT_PROMPT_TEMPLATE = "[ntfy] {{title}}\n{{message}}";
export const DEFAULT_STATE_FILE = path.join(".pi", "agent", "ntfy-state.json");
export const DEFAULT_ID_CAP = 500;
/** Bodies longer than this are truncated before being injected into the conversation. */
export const MAX_BODY_CHARS = 4000;
/** Titles longer than this are truncated before being injected into the conversation. */
export const MAX_TITLE_CHARS = 500;
/** Tags/click URLs longer than this are truncated before being injected. */
export const MAX_META_CHARS = 500;

/** ntfy topic names: 1..64 chars of [A-Za-z0-9_-]. */
const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

export type IdleDelivery = "user" | "custom";
export type StreamingDelivery = "steer" | "followUp";

/** Where the topic came from. Drives the status line and the “is this intentional?” call. */
export type ConfigSource = "env" | "file" | "none";

export interface NtfyConfig {
	/** A topic was supplied by some source. */
	configured: boolean;
	/** The extension should actually subscribe: configured, not disabled, no invalid values. */
	enabled: boolean;
	/** Which source supplied the topic. */
	source: ConfigSource;
	topic: string;
	server: string;
	token: string | undefined;
	minPriority: number;
	/** null = no tag filtering. */
	tagAllow: string[] | null;
	idleDelivery: IdleDelivery;
	streamingDelivery: StreamingDelivery;
	/** null = retry forever. 0 = never retry. */
	maxRetries: number | null;
	promptTemplate: string;
	stateFile: string;
	quiet: boolean;
	/** Non-fatal problems worth surfacing once. */
	warnings: string[];
	/**
	 * Invalid values that the user explicitly set (bad topic shape, bad server URL).
	 * These are worth telling the user about.
	 */
	errors: string[];
	/**
	 * Why the extension is inert when nothing was misconfigured — i.e. nobody asked for it.
	 * Debug-level only: “not every session needs this”, so an unconfigured extension must
	 * not nag on every start.
	 */
	reason: string | undefined;
}

export type EnvLike = Record<string, string | undefined>;

export interface ParseConfigOptions {
	env: EnvLike;
	/**
	 * Settings read from the config file, already mapped to `PI_NTFY_*` names
	 * (see `configFile.ts`). Lower priority than `env`.
	 */
	fileEnv?: EnvLike;
	homeDir: string;
}

/** Drop `undefined` entries so a spread cannot silently erase a file value. */
function definedOnly(source: EnvLike | undefined): EnvLike {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(source ?? {})) {
		if (value !== undefined) {
			out[key] = value;
		}
	}
	return out;
}

function trimmed(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const v = value.trim();
	return v.length > 0 ? v : undefined;
}

function parseBool(value: string | undefined): boolean {
	const v = trimmed(value)?.toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parseIntStrict(value: string | undefined): number | undefined {
	const v = trimmed(value);
	if (v === undefined) {
		return undefined;
	}
	if (!/^-?\d+$/.test(v)) {
		return undefined;
	}
	const n = Number.parseInt(v, 10);
	return Number.isSafeInteger(n) ? n : undefined;
}

export function parseConfig({ env: rawEnv, fileEnv, homeDir }: ParseConfigOptions): NtfyConfig {
	const warnings: string[] = [];
	const errors: string[] = [];
	let reason: string | undefined;

	// --- merge the two sources -------------------------------------------
	// `process.env` is full of undefined-valued keys; spreading it directly would wipe out
	// every value the config file contributed. env still wins where it is actually set.
	const fromFile = definedOnly(fileEnv);
	const fromEnv = definedOnly(rawEnv);
	const env: EnvLike = { ...fromFile, ...fromEnv };

	// --- topic (required) -------------------------------------------------
	const topicFromEnv = trimmed(fromEnv["PI_NTFY_TOPIC"]);
	const topicFromFile = trimmed(fromFile["PI_NTFY_TOPIC"]);
	const source: ConfigSource =
		topicFromEnv !== undefined ? "env" : topicFromFile !== undefined ? "file" : "none";
	const topic = topicFromEnv ?? topicFromFile ?? "";

	if (source === "none") {
		// Not an error: most sessions do not want an inbound alert channel. Stay silent.
		reason = "no topic configured (set PI_NTFY_TOPIC or use the ntfy_configure tool)";
	} else if (!TOPIC_RE.test(topic)) {
		errors.push(
			`topic ${JSON.stringify(topic)} is not a valid ntfy topic (expected 1-64 chars of A-Za-z0-9_-)`,
		);
	}

	// --- server -----------------------------------------------------------
	let server = trimmed(env["PI_NTFY_SERVER"]) ?? DEFAULT_SERVER;
	server = server.replace(/\/+$/, "");
	if (!/^https?:\/\/.+/i.test(server)) {
		errors.push(`PI_NTFY_SERVER ${JSON.stringify(server)} must be an http(s) URL`);
	}

	// --- token ------------------------------------------------------------
	const token = trimmed(env["PI_NTFY_TOKEN"]);

	// --- priority ---------------------------------------------------------
	const rawPriority = trimmed(env["PI_NTFY_MIN_PRIORITY"]);
	let minPriority = DEFAULT_MIN_PRIORITY;
	if (rawPriority !== undefined) {
		const parsed = parseIntStrict(rawPriority);
		if (parsed === undefined || parsed < 1 || parsed > 5) {
			warnings.push(
				`PI_NTFY_MIN_PRIORITY ${JSON.stringify(rawPriority)} is not an integer in 1..5; using ${DEFAULT_MIN_PRIORITY}`,
			);
		} else {
			minPriority = parsed;
		}
	}

	// --- tag allowlist ----------------------------------------------------
	const rawTags = trimmed(env["PI_NTFY_TAG_ALLOW"]);
	let tagAllow: string[] | null = null;
	if (rawTags !== undefined) {
		const tags = rawTags
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
		tagAllow = tags.length > 0 ? tags : null;
		if (tagAllow === null) {
			warnings.push("PI_NTFY_TAG_ALLOW was set but contained no tags; tag filtering is off");
		}
	}

	// --- delivery modes ---------------------------------------------------
	const rawIdle = trimmed(env["PI_NTFY_IDLE_DELIVERY"]);
	let idleDelivery: IdleDelivery = "user";
	if (rawIdle !== undefined) {
		if (rawIdle === "user" || rawIdle === "custom") {
			idleDelivery = rawIdle;
		} else {
			warnings.push(
				`PI_NTFY_IDLE_DELIVERY ${JSON.stringify(rawIdle)} is not "user" or "custom"; using "user"`,
			);
		}
	}

	const rawStreaming = trimmed(env["PI_NTFY_STREAMING_DELIVERY"]);
	let streamingDelivery: StreamingDelivery = "steer";
	if (rawStreaming !== undefined) {
		if (rawStreaming === "steer" || rawStreaming === "followUp") {
			streamingDelivery = rawStreaming;
		} else {
			warnings.push(
				`PI_NTFY_STREAMING_DELIVERY ${JSON.stringify(rawStreaming)} is not "steer" or "followUp"; using "steer"`,
			);
		}
	}

	// --- retries ----------------------------------------------------------
	const rawRetries = trimmed(env["PI_NTFY_MAX_RETRIES"]);
	let maxRetries: number | null = null;
	if (rawRetries !== undefined) {
		const parsed = parseIntStrict(rawRetries);
		if (parsed === undefined || parsed < 0) {
			warnings.push(
				`PI_NTFY_MAX_RETRIES ${JSON.stringify(rawRetries)} is not a non-negative integer; retrying forever`,
			);
		} else {
			maxRetries = parsed;
		}
	}

	// --- prompt template --------------------------------------------------
	const rawTemplate = env["PI_NTFY_PROMPT_TEMPLATE"];
	let promptTemplate = DEFAULT_PROMPT_TEMPLATE;
	if (rawTemplate !== undefined) {
		if (rawTemplate.trim().length === 0) {
			warnings.push("PI_NTFY_PROMPT_TEMPLATE was empty; using the default template");
		} else {
			promptTemplate = rawTemplate;
		}
	}

	// --- state file -------------------------------------------------------
	const rawStateFile = trimmed(env["PI_NTFY_STATE_FILE"]);
	let stateFile: string;
	if (rawStateFile === undefined) {
		stateFile = path.join(homeDir, DEFAULT_STATE_FILE);
	} else if (rawStateFile === "~") {
		// A bare `~` expands to the home *directory*, which can never be written as a
		// file. Fall back instead of silently configuring a guaranteed no-op.
		warnings.push("PI_NTFY_STATE_FILE=~ resolves to a directory; using the default file");
		stateFile = path.join(homeDir, DEFAULT_STATE_FILE);
	} else if (rawStateFile.startsWith("~/")) {
		stateFile = path.join(homeDir, rawStateFile.slice(2));
	} else {
		stateFile = rawStateFile;
	}

	// --- quiet ------------------------------------------------------------
	const quiet = parseBool(env["PI_NTFY_QUIET"]);

	return {
		configured: source !== "none",
		enabled: source !== "none" && errors.length === 0,
		source,
		topic,
		server,
		token,
		minPriority,
		tagAllow,
		idleDelivery,
		streamingDelivery,
		maxRetries,
		promptTemplate,
		stateFile,
		quiet,
		warnings,
		errors,
		reason,
	};
}
