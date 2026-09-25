/**
 * Persisted "already processed" id set.
 *
 * Why it exists: ntfy re-delivers nothing within a single stream, but process
 * restarts and reconnect races can re-deliver. A durable, capped set of recently
 * seen ids makes delivery at-most-once in practice without an unbounded file.
 *
 * The pure list manipulation is separated from the filesystem adapter so both are
 * easy to test and neither can throw into the caller.
 */

import fs from "node:fs";
import path from "node:path";

import { DEFAULT_ID_CAP } from "./config.js";

export interface StateLoadResult {
	ids: string[];
	error: string | undefined;
}

export interface StateSaveResult {
	ok: boolean;
	error: string | undefined;
}

/**
 * Append `id` to `ids`, dropping any earlier occurrence, then keep only the most
 * recent `cap` entries. Pure — returns a new array.
 */
export function appendCapped(ids: readonly string[], id: string, cap: number = DEFAULT_ID_CAP): string[] {
	const filtered = ids.filter((existing) => existing !== id);
	filtered.push(id);
	if (cap <= 0) {
		return [];
	}
	return filtered.length > cap ? filtered.slice(filtered.length - cap) : filtered;
}

export function makeIdSet(ids: readonly string[]): Set<string> {
	return new Set(ids);
}

function coerceIds(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === "string");
	}
	if (value !== null && typeof value === "object") {
		const candidate = (value as { ids?: unknown }).ids;
		if (Array.isArray(candidate)) {
			return candidate.filter((entry): entry is string => typeof entry === "string");
		}
	}
	return [];
}

/**
 * Read the persisted ids. Any problem (missing file, bad JSON, wrong shape, file
 * too large) yields an empty list plus an error string — never a throw.
 */
export function loadIds(file: string, maxBytes = 1024 * 1024): StateLoadResult {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) {
			return { ids: [], error: `${file} is not a regular file` };
		}
		if (stat.size > maxBytes) {
			return { ids: [], error: `${file} is ${stat.size} bytes, refusing to read (limit ${maxBytes})` };
		}
		const raw = fs.readFileSync(file, "utf8");
		if (raw.trim().length === 0) {
			return { ids: [], error: undefined };
		}
		return { ids: coerceIds(JSON.parse(raw) as unknown), error: undefined };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ids: [], error: undefined };
		}
		return { ids: [], error: String(error) };
	}
}

/**
 * Atomically persist the ids (write temp + rename). Returns a result instead of
 * throwing, so callers can log and carry on.
 */
export function saveIds(file: string, ids: readonly string[]): StateSaveResult {
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(tmp, `${JSON.stringify({ ids }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
