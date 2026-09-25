import { describe, expect, it } from "vitest";

import { evaluate, messagePriority, tagsIntersect } from "../src/filter.js";
import type { NtfyRawEvent } from "../src/ntfy.js";

function messageEvent(overrides: Partial<NtfyRawEvent> = {}): NtfyRawEvent {
	return {
		event: "message",
		id: "msg-1",
		time: 1_790_000_000,
		topic: "demo",
		title: "Hello",
		message: "World",
		priority: 3,
		tags: [],
		...overrides,
	};
}

const permissive = { minPriority: 1, tagAllow: null } as const;

describe("evaluate — rule 1: only message events", () => {
	it("accepts a message event", () => {
		const decision = evaluate(messageEvent(), permissive);
		expect(decision.deliver).toBe(true);
	});

	it.each(["open", "keepalive", "poll_request", "", "MESSAGE"])(
		"rejects event type %j",
		(eventType) => {
			const decision = evaluate(messageEvent({ event: eventType }), permissive);
			expect(decision).toEqual({ deliver: false, reason: "not-message" });
		},
	);

	it("rejects a non-string event field", () => {
		const decision = evaluate(messageEvent({ event: 42 }), permissive);
		expect(decision).toEqual({ deliver: false, reason: "not-message" });
	});
});

describe("evaluate — rule 2: malformed messages cannot be de-duplicated", () => {
	it("rejects a message without an id", () => {
		const decision = evaluate(messageEvent({ id: undefined }), permissive);
		expect(decision).toEqual({ deliver: false, reason: "malformed" });
	});

	it("rejects a message with an empty id", () => {
		const decision = evaluate(messageEvent({ id: "" }), permissive);
		expect(decision).toEqual({ deliver: false, reason: "malformed" });
	});

	it("rejects a message with a non-string id", () => {
		const decision = evaluate(messageEvent({ id: 7 }), permissive);
		expect(decision).toEqual({ deliver: false, reason: "malformed" });
	});
});

describe("evaluate — rule 3: minimum priority", () => {
	it("drops messages below the threshold", () => {
		const decision = evaluate(messageEvent({ priority: 2 }), { minPriority: 4, tagAllow: null });
		expect(decision).toEqual({ deliver: false, reason: "low-priority" });
	});

	it("keeps messages exactly at the threshold", () => {
		const decision = evaluate(messageEvent({ priority: 4 }), { minPriority: 4, tagAllow: null });
		expect(decision.deliver).toBe(true);
	});

	it("treats a missing priority as ntfy's default (3)", () => {
		expect(messagePriority(messageEvent({ priority: undefined }))).toBe(3);
		expect(evaluate(messageEvent({ priority: undefined }), { minPriority: 3, tagAllow: null }).deliver).toBe(true);
		expect(evaluate(messageEvent({ priority: undefined }), { minPriority: 4, tagAllow: null }).deliver).toBe(false);
	});

	it("accepts a numeric-looking string priority", () => {
		expect(messagePriority(messageEvent({ priority: "5" }))).toBe(5);
	});

	it("falls back to the default for a non-numeric priority", () => {
		expect(messagePriority(messageEvent({ priority: "oops" }))).toBe(3);
		expect(messagePriority(messageEvent({ priority: Number.NaN }))).toBe(3);
	});
});

describe("evaluate — rule 4: tag allowlist", () => {
	it("delivers when no allowlist is configured", () => {
		const decision = evaluate(messageEvent({ tags: ["anything"] }), { minPriority: 1, tagAllow: null });
		expect(decision.deliver).toBe(true);
	});

	it("drops messages whose tags do not intersect the allowlist", () => {
		const decision = evaluate(messageEvent({ tags: ["other"] }), {
			minPriority: 1,
			tagAllow: ["gprelay", "critical"],
		});
		expect(decision).toEqual({ deliver: false, reason: "tag-mismatch" });
	});

	it("keeps messages that carry an allowed tag", () => {
		const decision = evaluate(messageEvent({ tags: ["noise", "critical"] }), {
			minPriority: 1,
			tagAllow: ["gprelay", "critical"],
		});
		expect(decision.deliver).toBe(true);
	});

	it("drops untagged messages when an allowlist is configured", () => {
		const decision = evaluate(messageEvent({ tags: [] }), { minPriority: 1, tagAllow: ["gprelay"] });
		expect(decision).toEqual({ deliver: false, reason: "tag-mismatch" });
	});

	it("drops non-string tags during normalisation", () => {
		const decision = evaluate(messageEvent({ tags: [1, null, "gprelay"] }), {
			minPriority: 1,
			tagAllow: ["gprelay"],
		});
		expect(decision.deliver).toBe(true);
	});

	it("drops a message whose tags field is not an array", () => {
		const decision = evaluate(messageEvent({ tags: "gprelay" }), { minPriority: 1, tagAllow: ["gprelay"] });
		expect(decision).toEqual({ deliver: false, reason: "tag-mismatch" });
	});
});

describe("evaluate — rule 5: de-duplication", () => {
	it("drops a message whose id was already processed", () => {
		const decision = evaluate(messageEvent(), {
			minPriority: 1,
			tagAllow: null,
			isDuplicate: (id) => id === "msg-1",
		});
		expect(decision).toEqual({ deliver: false, reason: "duplicate" });
	});

	it("delivers when the duplicate predicate says no", () => {
		const decision = evaluate(messageEvent(), {
			minPriority: 1,
			tagAllow: null,
			isDuplicate: () => false,
		});
		expect(decision.deliver).toBe(true);
	});

	it("works without a duplicate predicate", () => {
		const decision = evaluate(messageEvent(), { minPriority: 1, tagAllow: null });
		expect(decision.deliver).toBe(true);
	});
});

describe("evaluate — rule ordering", () => {
	it("reports not-message before anything else", () => {
		const decision = evaluate(messageEvent({ event: "open", id: "", priority: 1 }), {
			minPriority: 5,
			tagAllow: [],
			isDuplicate: () => true,
		});
		expect(decision).toEqual({ deliver: false, reason: "not-message" });
	});

	it("reports malformed before priority and tags", () => {
		const decision = evaluate(messageEvent({ id: "", priority: 1, tags: [] }), {
			minPriority: 5,
			tagAllow: ["nope"],
		});
		expect(decision).toEqual({ deliver: false, reason: "malformed" });
	});

	it("reports low-priority before tag mismatch", () => {
		const decision = evaluate(messageEvent({ priority: 1, tags: [] }), {
			minPriority: 5,
			tagAllow: ["nope"],
		});
		expect(decision).toEqual({ deliver: false, reason: "low-priority" });
	});

	it("reports tag-mismatch before duplicate", () => {
		const decision = evaluate(messageEvent({ tags: [] }), {
			minPriority: 1,
			tagAllow: ["nope"],
			isDuplicate: () => true,
		});
		expect(decision).toEqual({ deliver: false, reason: "tag-mismatch" });
	});

	it("returns the normalised message on success", () => {
		const decision = evaluate(messageEvent({ title: "T", message: "M", tags: ["a"] }), permissive);
		expect(decision.deliver).toBe(true);
		if (decision.deliver) {
			expect(decision.message).toMatchObject({
				id: "msg-1",
				topic: "demo",
				title: "T",
				message: "M",
				tags: ["a"],
				priority: 3,
			});
		}
	});
});

describe("tagsIntersect", () => {
	it("returns false for an empty allowlist", () => {
		expect(tagsIntersect(["a"], [])).toBe(false);
	});

	it("returns false when the tags array is empty", () => {
		expect(tagsIntersect([], ["a"])).toBe(false);
	});

	it("returns true on overlap", () => {
		expect(tagsIntersect(["a", "b"], ["b", "c"])).toBe(true);
	});

	it("is exact-match, not prefix-match", () => {
		expect(tagsIntersect(["gp"], ["gprelay"])).toBe(false);
	});
});
