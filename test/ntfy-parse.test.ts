import { describe, expect, it } from "vitest";

import {
	backoffDelayMs,
	buildPublishUrl,
	buildSubscribeUrl,
	eventName,
	isKeepaliveEvent,
	isMessageEvent,
	isOpenEvent,
	parseNdjsonChunk,
	parseNdjsonLine,
	publish,
	subscribe,
	toMessage,
	type NtfyMessage,
	type NtfyRawEvent,
} from "../src/ntfy.js";

const encoder = new TextEncoder();

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const part of parts) {
				controller.enqueue(encoder.encode(part));
			}
			controller.close();
		},
	});
}

function okResponse(parts: string[]): Response {
	return new Response(streamOf(parts), { status: 200 });
}

describe("parseNdjsonLine", () => {
	it("parses a JSON object", () => {
		expect(parseNdjsonLine('{"event":"open"}')).toEqual({ event: "open" });
	});

	it("ignores blank lines", () => {
		expect(parseNdjsonLine("")).toBeNull();
		expect(parseNdjsonLine("   ")).toBeNull();
	});

	it("returns null for malformed JSON instead of throwing", () => {
		expect(parseNdjsonLine("{not json")).toBeNull();
		expect(parseNdjsonLine("}{")).toBeNull();
	});

	it("rejects non-object JSON", () => {
		expect(parseNdjsonLine("[]")).toBeNull();
		expect(parseNdjsonLine("null")).toBeNull();
		expect(parseNdjsonLine("42")).toBeNull();
		expect(parseNdjsonLine('"a string"')).toBeNull();
	});

	it("tolerates trailing carriage returns", () => {
		expect(parseNdjsonLine('{"event":"open"}\r')).toEqual({ event: "open" });
	});
});

describe("parseNdjsonChunk", () => {
	it("returns complete events and keeps the partial tail", () => {
		const result = parseNdjsonChunk("", '{"a":1}\n{"b":2}\n{"c"');
		expect(result.events).toEqual([{ a: 1 }, { b: 2 }]);
		expect(result.rest).toBe('{"c"');
	});

	it("completes a line split across two chunks", () => {
		const first = parseNdjsonChunk("", '{"a":');
		expect(first.events).toEqual([]);
		const second = parseNdjsonChunk(first.rest, "1}\n");
		expect(second.events).toEqual([{ a: 1 }]);
		expect(second.rest).toBe("");
	});

	it("skips blank and malformed lines", () => {
		const result = parseNdjsonChunk("", '\n{"a":1}\nnot json\n\n{"b":2}\n');
		expect(result.events).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("handles a chunk with no newline at all", () => {
		const result = parseNdjsonChunk("", '{"a":1}');
		expect(result.events).toEqual([]);
		expect(result.rest).toBe('{"a":1}');
	});

	it("handles an empty chunk", () => {
		expect(parseNdjsonChunk("", "")).toEqual({ events: [], rest: "" });
	});
});

describe("event predicates", () => {
	it("classifies events", () => {
		expect(isOpenEvent({ event: "open" })).toBe(true);
		expect(isOpenEvent({ event: "message" })).toBe(false);
		expect(isKeepaliveEvent({ event: "keepalive" })).toBe(true);
		expect(isKeepaliveEvent({ event: "open" })).toBe(false);
		expect(isMessageEvent({ event: "message" })).toBe(true);
		expect(isMessageEvent({ event: "open" })).toBe(false);
	});

	it("handles missing or non-string event fields", () => {
		expect(eventName({})).toBe("");
		expect(eventName({ event: 1 })).toBe("");
		expect(isMessageEvent({ event: undefined })).toBe(false);
	});
});

describe("toMessage", () => {
	const base: NtfyRawEvent = {
		event: "message",
		id: "AbC123",
		time: 1_790_355_119,
		topic: "demo",
		title: "T",
		message: "M",
		priority: 4,
		tags: ["a", "b"],
		click: "https://example.com",
	};

	it("normalises a full message", () => {
		expect(toMessage(base)).toEqual({
			id: "AbC123",
			time: 1_790_355_119,
			topic: "demo",
			title: "T",
			message: "M",
			priority: 4,
			tags: ["a", "b"],
			click: "https://example.com",
		});
	});

	it("returns null for a non-message event", () => {
		expect(toMessage({ ...base, event: "open" })).toBeNull();
		expect(toMessage({ ...base, event: "keepalive" })).toBeNull();
	});

	it("returns null when the id is missing or unusable", () => {
		expect(toMessage({ ...base, id: undefined })).toBeNull();
		expect(toMessage({ ...base, id: "" })).toBeNull();
		expect(toMessage({ ...base, id: 5 })).toBeNull();
	});

	it("defaults absent fields", () => {
		const result = toMessage({ event: "message", id: "x" });
		expect(result).toEqual({
			id: "x",
			time: 0,
			topic: "",
			title: "",
			message: "",
			priority: 3,
			tags: [],
			click: undefined,
		});
	});

	it("parses a numeric string priority and time", () => {
		const result = toMessage({ event: "message", id: "x", priority: "5", time: "123" });
		expect(result?.priority).toBe(5);
		expect(result?.time).toBe(123);
	});

	it("drops non-string tags", () => {
		expect(toMessage({ ...base, tags: [1, "a", null] })?.tags).toEqual(["a"]);
	});

	it("treats a non-array tags field as empty", () => {
		expect(toMessage({ ...base, tags: "a,b" })?.tags).toEqual([]);
	});

	it("treats an empty click as undefined", () => {
		expect(toMessage({ ...base, click: "" })?.click).toBeUndefined();
		expect(toMessage({ ...base, click: 7 })?.click).toBeUndefined();
	});
});

describe("URL builders", () => {
	it("builds the subscribe URL with since=none", () => {
		expect(buildSubscribeUrl("https://ntfy.sh", "demo")).toBe("https://ntfy.sh/demo/json?since=none");
	});

	it("tolerates trailing slashes on the server", () => {
		expect(buildSubscribeUrl("https://ntfy.sh///", "demo")).toBe("https://ntfy.sh/demo/json?since=none");
	});

	it("percent-encodes the topic", () => {
		expect(buildSubscribeUrl("https://ntfy.sh", "a/b")).toBe("https://ntfy.sh/a%2Fb/json?since=none");
	});

	it("builds the publish URL", () => {
		expect(buildPublishUrl("https://ntfy.sh/", "demo")).toBe("https://ntfy.sh/demo");
	});
});

describe("backoffDelayMs", () => {
	it("grows exponentially when random() is 1", () => {
		const one = () => 0.999_999;
		expect(backoffDelayMs(1, 1000, 60_000, one)).toBe(999);
		expect(backoffDelayMs(2, 1000, 60_000, one)).toBe(1999);
		expect(backoffDelayMs(3, 1000, 60_000, one)).toBe(3999);
	});

	it("never exceeds the cap", () => {
		expect(backoffDelayMs(20, 1000, 5000, () => 0.999_999)).toBeLessThanOrEqual(5000);
	});

	it("never drops below half the capped delay", () => {
		expect(backoffDelayMs(3, 1000, 60_000, () => 0)).toBe(2000);
	});

	it("handles attempt 0 and negatives defensively", () => {
		expect(backoffDelayMs(0, 1000, 60_000, () => 0)).toBe(500);
		expect(backoffDelayMs(-3, 1000, 60_000, () => 0)).toBe(500);
	});
});

describe("subscribe", () => {
	function collector(): NtfyMessage[] {
		return [];
	}

	it("does nothing when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const stats = await subscribe({
			server: "https://ntfy.sh",
			topic: "demo",
			signal: controller.signal,
			onMessage: () => undefined,
			fetchImpl: (async () => {
				calls += 1;
				return okResponse([]);
			}) as typeof fetch,
		});
		expect(calls).toBe(0);
		expect(stats).toEqual({ connections: 0, failures: 0, gaveUp: false });
	});

	it("dispatches open and message events and ignores keepalives", async () => {
		const messages = collector();
		const opens: number[] = [];
		const stats = await subscribe({
			server: "https://ntfy.sh",
			topic: "demo",
			signal: new AbortController().signal,
			onMessage: (m) => messages.push(m),
			onOpen: () => opens.push(1),
			maxRetries: 0,
			fetchImpl: (async () =>
				okResponse([
					'{"id":"1","event":"open","time":1}\n',
					'{"id":"k","event":"keepalive"}\n',
					'{"id":"m1","event":"message","title":"T","message":"M","priority":4}\n',
				])) as typeof fetch,
			sleep: async () => undefined,
			random: () => 0,
		});
		expect(opens).toHaveLength(1);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.id).toBe("m1");
		expect(stats.connections).toBe(1);
		// the stream ended, which counts as one failure, and maxRetries=0 gives up
		expect(stats.failures).toBe(1);
		expect(stats.gaveUp).toBe(true);
	});

	it("splits a message across chunk boundaries", async () => {
		const messages = collector();
		await subscribe({
			server: "https://ntfy.sh",
			topic: "demo",
			signal: new AbortController().signal,
			onMessage: (m) => messages.push(m),
			maxRetries: 0,
			fetchImpl: (async () =>
				okResponse(['{"id":"m1","event":"mess', 'age","title":"hello"}\n'])) as typeof fetch,
			sleep: async () => undefined,
			random: () => 0,
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]?.title).toBe("hello");
	});

	it("retries with backoff and reconnects", async () => {
		const messages = collector();
		const delays: number[] = [];
		const controller = new AbortController();
		let calls = 0;
		const stats = await subscribe({
			server: "https://ntfy.sh",
			topic: "demo",
			signal: controller.signal,
			onMessage: (m) => {
				messages.push(m);
				controller.abort();
			},
			fetchImpl: (async () => {
				calls += 1;
				if (calls < 3) {
					throw new Error("boom");
				}
				return okResponse(['{"id":"1","event":"open"}\n', '{"id":"m1","event":"message"}\n']);
			}) as typeof fetch,
			sleep: async (ms) => {
				delays.push(ms);
			},
			random: () => 0,
			backoffBaseMs: 1000,
		});
		expect(calls).toBe(3);
		expect(delays).toEqual([500, 1000]);
		expect(messages).toHaveLength(1);
		expect(stats.connections).toBe(1);
		expect(stats.failures).toBe(2);
		expect(stats.gaveUp).toBe(false);
	});

	it("treats a non-2xx response as a failure", async () => {
		const errors: Array<{ attempt: number; delay: number }> = [];
		const stats = await subscribe({
			server: "https://ntfy.sh",
			topic: "demo",
			signal: new AbortController().signal,
			onMessage: () => undefined,
			onError: (_error, attempt, delay) => errors.push({ attempt, delay }),
			maxRetries: 0,
			fetchImpl: (async () => new Response("nope", { status: 403 })) as typeof fetch,
			sleep: async () => undefined,
			random: () => 0,
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]?.attempt).toBe(1);
		expect(errors[0]?.delay).toBe(0);
		expect(stats.gaveUp).toBe(true);
	});

	it("sends a bearer token when configured", async () => {
		let seen: Record<string, string> | undefined;
		await subscribe({
			server: "https://ntfy.sh",
			topic: "demo",
			token: "tk_secret",
			signal: new AbortController().signal,
			onMessage: () => undefined,
			maxRetries: 0,
			fetchImpl: (async (_url: string, init: RequestInit) => {
				seen = init.headers as Record<string, string>;
				return okResponse([]);
			}) as unknown as typeof fetch,
			sleep: async () => undefined,
			random: () => 0,
		});
		expect(seen?.["Authorization"]).toBe("Bearer tk_secret");
	});

	it("omits the Authorization header without a token", async () => {
		let seen: Record<string, string> = {};
		await subscribe({
			server: "https://ntfy.sh",
			topic: "demo",
			signal: new AbortController().signal,
			onMessage: () => undefined,
			maxRetries: 0,
			fetchImpl: (async (_url: string, init: RequestInit) => {
				seen = init.headers as Record<string, string>;
				return okResponse([]);
			}) as unknown as typeof fetch,
			sleep: async () => undefined,
			random: () => 0,
		});
		expect(seen["Authorization"]).toBeUndefined();
	});

	it("subscribes with since=none so history is never replayed", async () => {
		const urls: string[] = [];
		await subscribe({
			server: "https://ntfy.example.com",
			topic: "demo",
			signal: new AbortController().signal,
			onMessage: () => undefined,
			maxRetries: 0,
			fetchImpl: (async (url: string) => {
				urls.push(url);
				return okResponse([]);
			}) as unknown as typeof fetch,
			sleep: async () => undefined,
			random: () => 0,
		});
		expect(urls).toEqual(["https://ntfy.example.com/demo/json?since=none"]);
	});

	it("stops retrying when the signal is aborted during backoff", async () => {
		const controller = new AbortController();
		let calls = 0;
		const stats = await subscribe({
			server: "https://ntfy.sh",
			topic: "demo",
			signal: controller.signal,
			onMessage: () => undefined,
			fetchImpl: (async () => {
				calls += 1;
				throw new Error("boom");
			}) as typeof fetch,
			sleep: async () => {
				controller.abort();
			},
			random: () => 0,
		});
		expect(calls).toBe(1);
		expect(stats.gaveUp).toBe(false);
		expect(stats.failures).toBe(1);
	});

	it("reports a response with no body as a failure", async () => {
		const stats = await subscribe({
			server: "https://ntfy.sh",
			topic: "demo",
			signal: new AbortController().signal,
			onMessage: () => undefined,
			maxRetries: 0,
			fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
			sleep: async () => undefined,
			random: () => 0,
		});
		expect(stats.failures).toBe(1);
		expect(stats.gaveUp).toBe(true);
	});
});

describe("publish", () => {
	it("posts the message with metadata headers", async () => {
		let seenUrl = "";
		let seenInit: RequestInit = {};
		const result = await publish({
			server: "https://ntfy.sh",
			topic: "demo",
			message: "hello",
			title: "T",
			priority: 4,
			tags: ["a", "b"],
			fetchImpl: (async (url: string, init: RequestInit) => {
				seenUrl = url;
				seenInit = init;
				return new Response("ok", { status: 200 });
			}) as unknown as typeof fetch,
		});
		expect(result).toEqual({ ok: true, status: 200, error: undefined });
		expect(seenUrl).toBe("https://ntfy.sh/demo");
		expect(seenInit.method).toBe("POST");
		expect(seenInit.body).toBe("hello");
		const headers = seenInit.headers as Record<string, string>;
		expect(headers["Title"]).toBe("T");
		expect(headers["Priority"]).toBe("4");
		expect(headers["Tags"]).toBe("a,b");
	});

	it("adds a bearer token when configured", async () => {
		let seenInit: RequestInit = {};
		await publish({
			server: "https://ntfy.sh",
			topic: "demo",
			message: "x",
			token: "tk",
			fetchImpl: (async (_url: string, init: RequestInit) => {
				seenInit = init;
				return new Response("", { status: 200 });
			}) as unknown as typeof fetch,
		});
		expect((seenInit.headers as Record<string, string>)["Authorization"]).toBe("Bearer tk");
	});

	it("omits optional headers when not provided", async () => {
		let seenInit: RequestInit = {};
		await publish({
			server: "https://ntfy.sh",
			topic: "demo",
			message: "x",
			fetchImpl: (async (_url: string, init: RequestInit) => {
				seenInit = init;
				return new Response("", { status: 200 });
			}) as unknown as typeof fetch,
		});
		const headers = seenInit.headers as Record<string, string>;
		expect(headers["Title"]).toBeUndefined();
		expect(headers["Priority"]).toBeUndefined();
		expect(headers["Tags"]).toBeUndefined();
	});

	it("reports a non-2xx status", async () => {
		const result = await publish({
			server: "https://ntfy.sh",
			topic: "demo",
			message: "x",
			fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch,
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe(500);
		expect(result.error).toBe("HTTP 500");
	});

	it("reports a network error instead of throwing", async () => {
		const result = await publish({
			server: "https://ntfy.sh",
			topic: "demo",
			message: "x",
			fetchImpl: (async () => {
				throw new Error("offline");
			}) as typeof fetch,
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe(0);
		expect(result.error).toContain("offline");
	});
});
