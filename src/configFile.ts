/**
 * The on-disk configuration file.
 *
 * Why it exists: an environment variable can only be set *before* pi starts, but the whole
 * point of this extension is that a **running** session — or the agent itself — can decide
 * "I want to be woken by external alerts". A file is the only place a running process can
 * persist that decision.
 *
 * Design rules:
 *  - nothing here throws: read/parse/write problems come back as `error` strings so the
 *    caller can degrade (a broken config file must never be worse than no config file).
 *  - the pure parts (path resolution, `$VAR` expansion, value→env mapping, masking) are
 *    separate from the filesystem adapter, so both are easy to test.
 *  - the file is a *lower* priority source than the environment. See `parseConfig`.
 */

import fs from "node:fs";
import path from "node:path";

import type { EnvLike } from "./config.js";

export const CONFIG_FILE_ENV = "PI_NTFY_CONFIG_FILE";
export const DEFAULT_CONFIG_FILE = path.join(".pi", "agent", "pi-ntfy.json");

/**
 * Raw JSON shape of the config file. Every field is `unknown` on purpose: the file is
 * user- and agent-editable, so it is untrusted input and gets validated on the way in.
 */
export interface ConfigFileValues {
	enabled?: unknown;
	topic?: unknown;
	server?: unknown;
	token?: unknown;
	minPriority?: unknown;
	tagAllow?: unknown;
	idleDelivery?: unknown;
	streamingDelivery?: unknown;
	maxRetries?: unknown;
	promptTemplate?: unknown;
	stateFile?: unknown;
	quiet?: unknown;
}

/** Every key the file understands, so writers can preserve unknown ones on merge. */
const KNOWN_KEYS: readonly (keyof ConfigFileValues)[] = [
	"enabled",
	"topic",
	"server",
	"token",
	"minPriority",
	"tagAllow",
	"idleDelivery",
	"streamingDelivery",
	"maxRetries",
	"promptTemplate",
	"stateFile",
	"quiet",
];

export interface LoadedConfigFile {
	/** Absolute path that was (or would be) read. */
	path: string;
	/** True when the file was present and parsed. */
	exists: boolean;
	/** Read/parse/write problem worth logging. Never a reason to throw. */
	error: string | undefined;
	/** `enabled: false` in the file — an explicit "off" rather than "never configured". */
	disabled: boolean;
	/** The file's settings mapped onto `PI_NTFY_*` names, ready to merge with the env. */
	env: EnvLike;
	/** The parsed JSON, for read-modify-write. */
	values: ConfigFileValues;
}

/**
 * Resolve the config file path. `PI_NTFY_CONFIG_FILE` wins; a bare `~` and a leading `~/`
 * are expanded, and a bare `~` (which would name a directory) falls back to the default.
 */
export function configFilePath(env: EnvLike, homeDir: string): string {
	const raw = env[CONFIG_FILE_ENV]?.trim();
	if (raw === undefined || raw.length === 0) {
		return path.join(homeDir, DEFAULT_CONFIG_FILE);
	}
	if (raw === "~") {
		return path.join(homeDir, DEFAULT_CONFIG_FILE);
	}
	if (raw.startsWith("~/")) {
		return path.join(homeDir, raw.slice(2));
	}
	return raw;
}

const VAR_REF_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

/**
 * Expand a *whole-value* environment reference (`$VAR` or `${VAR}`).
 *
 * Deliberately whole-value only: partial substitution would silently rewrite a
 * `promptTemplate` that happens to contain a `$`, and an unreplaced `$` is much easier to
 * debug than a mysteriously mangled template. An unresolvable reference is left verbatim so
 * the mistake is visible rather than becoming an empty string.
 */
export function expandVars(value: string, env: EnvLike): string {
	const match = VAR_REF_RE.exec(value);
	if (match === null) {
		return value;
	}
	const resolved = env[match[1] as string];
	return resolved === undefined ? value : resolved;
}

function asString(value: unknown, env: EnvLike): string | undefined {
	if (typeof value === "string") {
		return expandVars(value, env);
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	if (typeof value === "boolean") {
		return value ? "1" : "";
	}
	return undefined;
}

function asList(value: unknown, env: EnvLike): string | undefined {
	if (Array.isArray(value)) {
		const items = value
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => expandVars(entry, env))
			.filter((entry) => entry.trim().length > 0);
		return items.length > 0 ? items.join(",") : undefined;
	}
	const single = asString(value, env);
	return single;
}

/**
 * Map the file's settings onto the `PI_NTFY_*` names the parser already understands.
 *
 * Going through the same env shape (rather than a parallel parser) means validation,
 * warnings and defaults stay in exactly one place.
 */
export function toEnvLike(values: ConfigFileValues, env: EnvLike): EnvLike {
	const out: Record<string, string | undefined> = {};

	const put = (key: string, value: string | undefined): void => {
		if (value !== undefined && value.length > 0) {
			out[key] = value;
		}
	};

	put("PI_NTFY_TOPIC", asString(values.topic, env));
	put("PI_NTFY_SERVER", asString(values.server, env));
	put("PI_NTFY_TOKEN", asString(values.token, env));
	put("PI_NTFY_MIN_PRIORITY", asString(values.minPriority, env));
	put("PI_NTFY_TAG_ALLOW", asList(values.tagAllow, env));
	put("PI_NTFY_IDLE_DELIVERY", asString(values.idleDelivery, env));
	put("PI_NTFY_STREAMING_DELIVERY", asString(values.streamingDelivery, env));
	put("PI_NTFY_MAX_RETRIES", asString(values.maxRetries, env));
	put("PI_NTFY_PROMPT_TEMPLATE", asString(values.promptTemplate, env));
	put("PI_NTFY_STATE_FILE", asString(values.stateFile, env));
	if (values.quiet === true) {
		out["PI_NTFY_QUIET"] = "1";
	}

	return out;
}

/** Parse file contents. Returns `{}` plus an error string for anything unusable. */
export function parseConfigFile(raw: string): { values: ConfigFileValues; error: string | undefined } {
	if (raw.trim().length === 0) {
		return { values: {}, error: undefined };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { values: {}, error: `not valid JSON (${String(error)})` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { values: {}, error: "expected a JSON object" };
	}
	return { values: parsed as ConfigFileValues, error: undefined };
}

/** Read + parse the config file. Missing file is not an error. */
export function readConfigFile(file: string, env: EnvLike = process.env): LoadedConfigFile {
	const base: LoadedConfigFile = {
		path: file,
		exists: false,
		error: undefined,
		disabled: false,
		env: {},
		values: {},
	};

	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return base;
		}
		return { ...base, error: String(error) };
	}

	const { values, error } = parseConfigFile(raw);
	if (error !== undefined) {
		return { ...base, exists: true, error };
	}

	return {
		path: file,
		exists: true,
		error: undefined,
		disabled: values.enabled === false,
		env: toEnvLike(values, env),
		values,
	};
}

/**
 * Merge `patch` into the config file, preserving keys we do not know about, and write it
 * atomically (temp + rename) so a crash can never leave a half-written file behind.
 */
export function writeConfigFile(
	file: string,
	patch: ConfigFileValues,
): { ok: boolean; error: string | undefined } {
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		let values: ConfigFileValues = {};
		try {
			const existing = fs.readFileSync(file, "utf8");
			const parsed = parseConfigFile(existing);
			values = parsed.values;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				// An unreadable-but-present file: refuse rather than silently clobber it.
				return { ok: false, error: `cannot read ${file}: ${String(error)}` };
			}
		}

		for (const [key, value] of Object.entries(patch)) {
			values[key as keyof ConfigFileValues] = value;
		}

		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(tmp, file);
		return { ok: true, error: undefined };
	} catch (error) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// best effort
		}
		return { ok: false, error: String(error) };
	}
}

/** The keys a writer is allowed to touch. Anything else is preserved verbatim. */
export function isKnownKey(key: string): key is keyof ConfigFileValues {
	return (KNOWN_KEYS as readonly string[]).includes(key);
}

/**
 * Describe a secret without revealing it. `get` output goes into the model's context and
 * the transcript, so the token value itself must never appear there.
 */
export function describeSecret(value: string | undefined): "set" | "unset" {
	return value === undefined || value.length === 0 ? "unset" : "set";
}
