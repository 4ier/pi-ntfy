/**
 * ntfy protocol: NDJSON parsing (pure), the streaming subscriber, and a publish helper.
 *
 * Protocol reference (see SPEC §4):
 *   GET  {server}/{topic}/json?since=none   -> newline-delimited JSON, long-lived
 *   POST {server}/{topic}                   -> publish (body = message)
 *
 * `since=none` is deliberate: it makes a reconnect subscribe to *new* messages only,
 * so a flapping connection can never replay a backlog into the conversation.
 */

import { NTFY_DEFAULT_PRIORITY } from "./config.js";

export interface NtfyRawEvent {
	id?: unknown;
	time?: unknown;
	event?: unknown;
	topic?: unknown;
	title?: unknown;
	message?: unknown;
	priority?: unknown;
	tags?: unknown;
	click?: unknown;
	actions?: unknown;
	attachment?: unknown;
}

export interface NtfyMessage {
	id: string;
	time: number;
	topic: string;
	title: string;
	message: string;
	priority: number;
	tags: string[];
	click: string | undefined;
}

/** Parse one NDJSON line. Returns null (never throws) for anything unusable. */
export function parseNdjsonLine(line: string): NtfyRawEvent | null {
	const trimmed = line.trim();
	if (trimmed.length === 0) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	return parsed as NtfyRawEvent;
}

/**
 * Feed a raw chunk into the line buffer, returning the complete events plus the
 * leftover partial line to carry into the next chunk.
 */
export function parseNdjsonChunk(rest: string, chunk: string): { events: NtfyRawEvent[]; rest: string } {
	const combined = rest + chunk;
	const parts = combined.split("\n");
	const tail = parts.pop() ?? "";
	const events: NtfyRawEvent[] = [];
	for (const part of parts) {
		const event = parseNdjsonLine(part);
		if (event !== null) {
			events.push(event);
		}
	}
	return { events, rest: tail };
}

export function eventName(raw: NtfyRawEvent): string {
	return typeof raw.event === "string" ? raw.event : "";
}

export function isOpenEvent(raw: NtfyRawEvent): boolean {
	return eventName(raw) === "open";
}

export function isKeepaliveEvent(raw: NtfyRawEvent): boolean {
	return eventName(raw) === "keepalive";
}

export function isMessageEvent(raw: NtfyRawEvent): boolean {
	return eventName(raw) === "message";
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const n = Number(value);
		if (Number.isFinite(n)) {
			return n;
		}
	}
	return fallback;
}

/**
 * Normalise a raw `message` event. Returns null when the event is not a message or
 * carries no usable id (an id is required for de-duplication).
 */
export function toMessage(raw: NtfyRawEvent): NtfyMessage | null {
	if (!isMessageEvent(raw)) {
		return null;
	}
	const id = asString(raw.id);
	if (id.length === 0) {
		return null;
	}
	const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [];
	const click = asString(raw.click);
	return {
		id,
		time: asNumber(raw.time, 0),
		topic: asString(raw.topic),
		title: asString(raw.title),
		message: asString(raw.message),
		priority: asNumber(raw.priority, NTFY_DEFAULT_PRIORITY),
		tags,
		click: click.length > 0 ? click : undefined,
	};
}

export function buildSubscribeUrl(server: string, topic: string): string {
	return `${server.replace(/\/+$/, "")}/${encodeURIComponent(topic)}/json?since=none`;
}

export function buildPublishUrl(server: string, topic: string): string {
	return `${server.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`;
}

export function backoffDelayMs(
	attempt: number,
	baseMs: number,
	maxMs: number,
	random: () => number,
): number {
	const exponent = Math.max(0, attempt - 1);
	const capped = Math.min(baseMs * 2 ** exponent, maxMs);
	// equal jitter: never below half of the capped delay, never above it
	const half = capped / 2;
	return Math.floor(half + random() * half);
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted || ms <= 0) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export interface SubscribeOptions {
	server: string;
	topic: string;
	token?: string | undefined;
	signal: AbortSignal;
	onMessage: (message: NtfyMessage) => void;
	onOpen?: (() => void) | undefined;
	onError?: ((error: unknown, attempt: number, delayMs: number) => void) | undefined;
	/** null = retry forever, N = allow N retries before giving up, 0 = never retry. */
	maxRetries?: number | null;
	fetchImpl?: typeof fetch | undefined;
	backoffBaseMs?: number | undefined;
	backoffMaxMs?: number | undefined;
	/**
	 * A stream must stay open at least this long before it counts as a real
	 * connection and resets the backoff. Without it, a server or proxy that
	 * accepts the request and closes immediately would reset the backoff on every
	 * response and retry at a fixed sub-second interval forever.
	 */
	stableStreamMs?: number | undefined;
	random?: (() => number) | undefined;
	now?: (() => number) | undefined;
	sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

export interface SubscribeStats {
	/** Streams that reached `event: open`. */
	connections: number;
	/** Consumer-visible connection failures (excludes the final give-up). */
	failures: number;
	/** True when the loop stopped because maxRetries was exhausted. */
	gaveUp: boolean;
}

function buildHeaders(token: string | undefined): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/x-ndjson" };
	if (token !== undefined) {
		headers["Authorization"] = `Bearer ${token}`;
	}
	return headers;
}

async function readStream(
	response: Response,
	dispatch: (raw: NtfyRawEvent) => void,
): Promise<void> {
	const body = response.body;
	if (body === null) {
		throw new Error("ntfy response had no body");
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let rest = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value === undefined) {
				continue;
			}
			const parsed = parseNdjsonChunk(rest, decoder.decode(value, { stream: true }));
			rest = parsed.rest;
			for (const raw of parsed.events) {
				dispatch(raw);
			}
		}
		const tail = decoder.decode();
		const parsed = parseNdjsonChunk(rest, tail);
		for (const raw of parsed.events) {
			dispatch(raw);
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// ignore
		}
	}
}

/**
 * Run the subscriber until `signal` is aborted or (when `maxRetries` is a number)
 * the retry budget is exhausted. Resolves; never rejects.
 */
export async function subscribe(options: SubscribeOptions): Promise<SubscribeStats> {
	const {
		server,
		topic,
		token,
		signal,
		onMessage,
		onOpen,
		onError,
		maxRetries = null,
		fetchImpl = globalThis.fetch,
		backoffBaseMs = 1000,
		backoffMaxMs = 60_000,
		stableStreamMs = 30_000,
		random = Math.random,
		now = Date.now,
		sleep = defaultSleep,
	} = options;

	const stats: SubscribeStats = { connections: 0, failures: 0, gaveUp: false };
	const url = buildSubscribeUrl(server, topic);
	let attempt = 0;

	const dispatch = (raw: NtfyRawEvent): void => {
		if (isOpenEvent(raw)) {
			stats.connections += 1;
			onOpen?.();
			return;
		}
		if (isKeepaliveEvent(raw)) {
			return;
		}
		const message = toMessage(raw);
		if (message !== null) {
			onMessage(message);
		}
	};

	while (!signal.aborted) {
		try {
			const response = await fetchImpl(url, { headers: buildHeaders(token), signal });
			if (!response.ok) {
				throw new Error(`ntfy returned HTTP ${response.status}`);
			}
			const connectedAt = now();
			await readStream(response, dispatch);
			// Only a stream that actually lived for a while proves the endpoint is
			// healthy. Resetting on the response headers alone (the previous
			// behaviour) meant "connect OK then close at once" retried forever at
			// ~2 req/s and never escalated towards backoffMaxMs.
			if (now() - connectedAt >= stableStreamMs) {
				attempt = 0;
			}
			throw new Error("ntfy stream ended");
		} catch (error) {
			if (signal.aborted) {
				return stats;
			}
			attempt += 1;
			stats.failures += 1;
			if (maxRetries !== null && attempt > maxRetries) {
				stats.gaveUp = true;
				onError?.(error, attempt, 0);
				return stats;
			}
			const delay = backoffDelayMs(attempt, backoffBaseMs, backoffMaxMs, random);
			onError?.(error, attempt, delay);
			await sleep(delay, signal);
		}
	}

	return stats;
}

export interface PublishOptions {
	server: string;
	topic: string;
	token?: string | undefined;
	message: string;
	title?: string | undefined;
	priority?: number | undefined;
	tags?: string[] | undefined;
	fetchImpl?: typeof fetch | undefined;
}

export interface PublishResult {
	ok: boolean;
	status: number;
	error: string | undefined;
}

/** Publish one message. Resolves with a result object; never rejects. */
export async function publish(options: PublishOptions): Promise<PublishResult> {
	const { server, topic, token, message, title, priority, tags, fetchImpl = globalThis.fetch } = options;
	const headers = buildHeaders(token);
	headers["Content-Type"] = "text/plain";
	if (title !== undefined) {
		headers["Title"] = title;
	}
	if (priority !== undefined) {
		headers["Priority"] = String(priority);
	}
	if (tags !== undefined && tags.length > 0) {
		headers["Tags"] = tags.join(",");
	}
	try {
		const response = await fetchImpl(buildPublishUrl(server, topic), {
			method: "POST",
			headers,
			body: message,
		});
		if (!response.ok) {
			return { ok: false, status: response.status, error: `HTTP ${response.status}` };
		}
		return { ok: true, status: response.status, error: undefined };
	} catch (error) {
		return { ok: false, status: 0, error: String(error) };
	}
}
