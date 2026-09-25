/**
 * The delivery filter pipeline (pure).
 *
 * Order is part of the contract (SPEC §6.3). Each rule is also exported on its own so
 * tests can exercise it in isolation:
 *
 *   1. not a `message` event            -> not-message
 *   2. no usable id (cannot dedupe)     -> malformed      [see note]
 *   3. priority below the threshold     -> low-priority
 *   4. tag allowlist set, no overlap    -> tag-mismatch
 *   5. id already processed             -> duplicate
 *   otherwise                           -> deliver
 *
 * [note] SPEC §6.3 does not list a malformed-event rule. It is required in practice:
 * de-duplication is keyed on the ntfy message id, so an id-less message would be
 * delivered identically on every reconnect. Dropping it is the safe choice.
 */

import { NTFY_DEFAULT_PRIORITY } from "./config.js";
import { eventName, toMessage, type NtfyMessage, type NtfyRawEvent } from "./ntfy.js";

export type FilterReason =
	| "not-message"
	| "malformed"
	| "low-priority"
	| "tag-mismatch"
	| "duplicate";

export type FilterDecision =
	| { deliver: true; message: NtfyMessage }
	| { deliver: false; reason: FilterReason };

export interface FilterOptions {
	/** Minimum ntfy priority (1..5) that is allowed through. */
	minPriority: number;
	/** null = no tag filtering. */
	tagAllow: readonly string[] | null;
	/** Returns true when this id was already delivered. */
	isDuplicate?: ((id: string) => boolean) | undefined;
}

export function messagePriority(raw: NtfyRawEvent): number {
	const value = raw.priority;
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const n = Number(value);
		if (Number.isFinite(n)) {
			return n;
		}
	}
	return NTFY_DEFAULT_PRIORITY;
}

/** True when `tags` shares at least one entry with `allow`. */
export function tagsIntersect(tags: readonly string[], allow: readonly string[]): boolean {
	if (allow.length === 0) {
		return false;
	}
	for (const tag of tags) {
		if (allow.includes(tag)) {
			return true;
		}
	}
	return false;
}

export function evaluate(raw: NtfyRawEvent, options: FilterOptions): FilterDecision {
	if (eventName(raw) !== "message") {
		return { deliver: false, reason: "not-message" };
	}

	const message = toMessage(raw);
	if (message === null) {
		return { deliver: false, reason: "malformed" };
	}

	if (message.priority < options.minPriority) {
		return { deliver: false, reason: "low-priority" };
	}

	if (options.tagAllow !== null && !tagsIntersect(message.tags, options.tagAllow)) {
		return { deliver: false, reason: "tag-mismatch" };
	}

	if (options.isDuplicate?.(message.id) === true) {
		return { deliver: false, reason: "duplicate" };
	}

	return { deliver: true, message };
}
