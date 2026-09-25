/**
 * Integration smoke test for the extension entry point.
 *
 * It drives `src/index.ts` with a stub `ExtensionAPI` and a stub `fetch`, so the real
 * wiring (session_start -> subscribe -> filter -> template -> delivery) is exercised
 * without a running pi and without touching the network.
 *
 * This file is an addition to the layout in SPEC §7; the pure-module unit tests stay
 * where the spec put them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ExtensionFactory = (api: ExtensionAPI) => void;

/**
 * `src/index.ts` keeps module-level state (the active runtime + pi handle), which is
 * correct for one process but leaks between tests. Reload a fresh module instance per
 * test so each case starts from a clean slate.
 */
async function loadExtension(): Promise<ExtensionFactory> {
	vi.resetModules();
	const mod = (await import("../src/index.js")) as { default: ExtensionFactory };
	return mod.default;
}

const encoder = new TextEncoder();

const ENV_KEYS = [
	"PI_NTFY_TOPIC",
	"PI_NTFY_SERVER",
	"PI_NTFY_TOKEN",
	"PI_NTFY_MIN_PRIORITY",
	"PI_NTFY_TAG_ALLOW",
	"PI_NTFY_IDLE_DELIVERY",
	"PI_NTFY_STREAMING_DELIVERY",
	"PI_NTFY_MAX_RETRIES",
	"PI_NTFY_PROMPT_TEMPLATE",
	"PI_NTFY_STATE_FILE",
	"PI_NTFY_QUIET",
	"PI_NTFY_CONFIG_FILE",
] as const;

interface Harness {
	api: ExtensionAPI;
	handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>;
	commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
	sent: Array<{ message: unknown; options: unknown }>;
	/** Both arguments are kept: dropping `options` made a P2-A regression invisible. */
	userMessages: Array<{ text: string; options: unknown }>;
	tools: Map<string, { description?: string; execute: (...args: unknown[]) => Promise<unknown> }>;
	notifications: Array<{ text: string; level: string }>;
	statuses: Array<[string, string | undefined]>;
	ctx: unknown;
}

function makeHarness(): Harness {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>();
	const commands = new Map<
		string,
		{ description?: string; handler: (args: string, ctx: unknown) => Promise<void> }
	>();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const userMessages: Array<{ text: string; options: unknown }> = [];
	const notifications: Array<{ text: string; level: string }> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const tools = new Map<string, { description?: string; execute: (...args: unknown[]) => Promise<unknown> }>();

	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		mode: "interactive",
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			notify: (text: string, level: string) => {
				notifications.push({ text, level });
			},
			setStatus: (key: string, value: string | undefined) => {
				statuses.push([key, value]);
			},
		},
	};

	const api = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => {
			handlers.set(name, handler);
		},
		registerCommand: (
			name: string,
			definition: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
		) => {
			commands.set(name, definition);
		},
		sendMessage: (message: unknown, options: unknown) => {
			sent.push({ message, options });
		},
		sendUserMessage: (text: string, options?: unknown) => {
			userMessages.push({ text, options });
		},
		registerTool: (
			definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> },
		) => {
			tools.set(definition.name, definition);
		},
		appendEntry: () => undefined,
		events: { on: () => undefined, emit: () => undefined },
	} as unknown as ExtensionAPI;

	return { api, handlers, commands, sent, userMessages, tools, notifications, statuses, ctx };
}

function streamResponse(lines: string[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(line));
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200 });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timeout waiting for condition");
}

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;
let liveHarnesses: Harness[] = [];

beforeEach(() => {
	liveHarnesses = [];
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ntfy-smoke-"));
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env["PI_NTFY_STATE_FILE"] = path.join(tmpDir, "state.json");
	// Point the config file at a path inside the temp dir. Without this the suite would read
	// the developer's real ~/.pi/agent/pi-ntfy.json and pass or fail depending on their machine.
	process.env["PI_NTFY_CONFIG_FILE"] = path.join(tmpDir, "pi-ntfy.json");
});

afterEach(async () => {
	// stop every subscriber before the fetch stub goes away, otherwise a detached loop
	// would fall through to the real global fetch
	for (const harness of liveHarnesses) {
		const shutdown = harness.handlers.get("session_shutdown");
		if (shutdown !== undefined) {
			await shutdown({}, harness.ctx);
		}
	}
	liveHarnesses = [];
	await new Promise((resolve) => setTimeout(resolve, 20));
	vi.unstubAllGlobals();
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function startSession(harness: Harness): Promise<void> {
	const handler = harness.handlers.get("session_start");
	expect(handler).toBeDefined();
	await handler?.({}, harness.ctx);
}

describe("extension entry", () => {
	it("exports a factory function", async () => {
		expect(typeof (await loadExtension())).toBe("function");
	});

	it("stays completely silent when nothing is configured", async () => {
		// Regression for the reported annoyance: an unconfigured extension used to warn in
		// every session ("Warning: pi-ntfy disabled: PI_NTFY_TOPIC is not set"). Not every
		// session wants an inbound alert channel, so this state must be invisible.
		const harness = makeHarness();
		const fetchMock = vi.fn(async () => streamResponse([]));
		vi.stubGlobal("fetch", fetchMock);

		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);

		expect(harness.notifications).toEqual([]);
		// Clearing the footer is allowed (it leaves no visible entry); *setting* one is not.
		expect(harness.statuses.every(([, value]) => value === undefined)).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("registers one /ntfy command and the self-configuration tool", async () => {
		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		expect([...harness.commands.keys()]).toEqual(["ntfy"]);
		expect(harness.commands.get("ntfy")?.description).toContain("pi-ntfy");
		// The tool must exist even in a session that started unconfigured: it is how the
		// agent turns alerts on for itself.
		expect([...harness.tools.keys()]).toEqual(["ntfy_configure"]);
	});

	it("delivers an ntfy message as a user turn when idle", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		const fetchMock = vi.fn(async () =>
			streamResponse([
				'{"id":"1","event":"open"}\n',
				'{"id":"m1","event":"message","topic":"demo","title":"Backup stalled","message":"no progress","priority":4}\n',
			]),
		);
		vi.stubGlobal("fetch", fetchMock);

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		await waitFor(() => harness.userMessages.length > 0);

		expect(harness.userMessages[0]?.text).toBe("[ntfy] Backup stalled\nno progress");
		// idle delivery must still name a delivery mode so that losing the
		// isIdle() race queues the message instead of rejecting it
		expect(harness.userMessages[0]?.options).toMatchObject({ deliverAs: "steer" });
		expect(harness.statuses).toContainEqual(["ntfy", "ntfy: connected"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("honours a custom prompt template", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		process.env["PI_NTFY_PROMPT_TEMPLATE"] = "ALERT<{{title}}|{{tags}}|p{{priority}}>";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				streamResponse([
					'{"id":"m1","event":"message","title":"T","tags":["a","b"],"priority":5}\n',
				]),
			),
		);

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		await waitFor(() => harness.userMessages.length > 0);

		expect(harness.userMessages[0]?.text).toBe("ALERT<T|a,b|p5>");
	});

	it("uses an extension-authored message when idle delivery is custom", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		process.env["PI_NTFY_IDLE_DELIVERY"] = "custom";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => streamResponse(['{"id":"m1","event":"message","title":"T"}\n'])),
		);

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		await waitFor(() => harness.sent.length > 0);

		expect(harness.userMessages).toHaveLength(0);
		expect(harness.sent[0]?.message).toMatchObject({ customType: "ntfy", display: true });
	});

	it("steers instead of starting a turn while the agent is busy", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => streamResponse(['{"id":"m1","event":"message","title":"T"}\n'])),
		);

		const harness = makeHarness();
		(harness.ctx as { isIdle: () => boolean }).isIdle = () => false;
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		await waitFor(() => harness.sent.length > 0);

		expect(harness.userMessages).toHaveLength(0);
		expect(harness.sent[0]?.options).toMatchObject({ deliverAs: "steer", triggerTurn: true });
	});

	it("drops duplicates across a session restart using the persisted ids", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		const line = '{"id":"dup-1","event":"message","title":"T"}\n';
		vi.stubGlobal("fetch", vi.fn(async () => streamResponse([line])));

		const first = makeHarness();
		(await loadExtension())(first.api);
		liveHarnesses.push(first);
		await startSession(first);
		await waitFor(() => first.userMessages.length > 0);

		const second = makeHarness();
		(await loadExtension())(second.api);
		liveHarnesses.push(second);
		await startSession(second);
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(second.userMessages).toHaveLength(0);
	});

	it("persists processed ids to the configured state file", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => streamResponse(['{"id":"persist-1","event":"message","title":"T"}\n'])),
		);

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		await waitFor(() => harness.userMessages.length > 0);

		const raw = fs.readFileSync(process.env["PI_NTFY_STATE_FILE"] as string, "utf8");
		expect(JSON.parse(raw)).toEqual({ ids: ["persist-1"] });
	});

	it("ignores messages below the configured priority", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		process.env["PI_NTFY_MIN_PRIORITY"] = "5";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => streamResponse(['{"id":"m1","event":"message","priority":1,"title":"T"}\n'])),
		);

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(harness.userMessages).toHaveLength(0);
	});

	it("reports status through the /ntfy command", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		vi.stubGlobal("fetch", vi.fn(async () => streamResponse(['{"id":"1","event":"open"}\n'])));

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		await waitFor(() => harness.statuses.some(([, value]) => value === "ntfy: connected"));

		await harness.commands.get("ntfy")?.handler("", harness.ctx);
		const status = harness.notifications.at(-1)?.text ?? "";
		expect(status).toContain("topic:      demo");
		expect(status).toContain("connected:  yes");
	});

	it("answers the /ntfy ids subcommand", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		vi.stubGlobal("fetch", vi.fn(async () => streamResponse([])));

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		await harness.commands.get("ntfy")?.handler("ids", harness.ctx);

		expect(harness.notifications.at(-1)?.text).toContain("remembers 0");
	});

	it("rejects an unknown /ntfy subcommand", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		vi.stubGlobal("fetch", vi.fn(async () => streamResponse([])));

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		await harness.commands.get("ntfy")?.handler("bogus", harness.ctx);

		expect(harness.notifications.at(-1)?.text).toContain("unknown subcommand");
	});

	it("publishes with /ntfy test", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		await harness.commands.get("ntfy")?.handler("test hello there", harness.ctx);

		expect(harness.notifications.at(-1)?.text).toContain("published test message");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://ntfy.sh/demo",
			expect.objectContaining({ method: "POST", body: "hello there" }),
		);
	});

	it("surfaces a publish failure", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		await harness.commands.get("ntfy")?.handler("test", harness.ctx);

		const last = harness.notifications.at(-1);
		expect(last?.level).toBe("error");
		expect(last?.text).toContain("HTTP 403");
	});

	it("reports the effective configuration when asked before a session starts", async () => {
		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await harness.commands.get("ntfy")?.handler("", harness.ctx);

		const text = harness.notifications.at(-1)?.text ?? "";
		// The snapshot is machine-readable so an agent can read it back.
		expect(text).toContain("\"configured\": false");
		expect(text).toContain("configFile");
	});

	it("never leaks the token in the status snapshot", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		process.env["PI_NTFY_TOKEN"] = "super-secret-value";

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await harness.commands.get("ntfy")?.handler("", harness.ctx);

		const text = harness.notifications.at(-1)?.text ?? "";
		expect(text).not.toContain("super-secret-value");
		// The snapshot only ever says whether a token exists.
		expect(text).toContain("\"token\": \"set\"");
	});

	it("shuts the subscriber down and reports stopped status", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		vi.stubGlobal("fetch", vi.fn(async () => streamResponse(['{"id":"1","event":"open"}\n'])));

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		await waitFor(() => harness.statuses.some(([, value]) => value === "ntfy: connected"));

		await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
		// Shutdown clears the footer rather than leaving a stale "stopped" entry behind.
		expect(harness.statuses.at(-1)).toEqual(["ntfy", undefined]);
	});

	it("never throws out of session_start when the state file is unwritable", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		process.env["PI_NTFY_STATE_FILE"] = path.join(tmpDir, "afile", "nested.json");
		fs.writeFileSync(path.join(tmpDir, "afile"), "x");
		vi.stubGlobal("fetch", vi.fn(async () => streamResponse(['{"id":"m1","event":"message"}\n'])));

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await expect(startSession(harness)).resolves.toBeUndefined();
		await waitFor(() => harness.userMessages.length > 0);
	});
});

describe("on-demand configuration (0.2.0)", () => {
	/** Drive the config tool the way the LLM would. */
	async function callTool(
		harness: Harness,
		params: Record<string, unknown>,
	): Promise<{ text: string; isError: boolean }> {
		const tool = harness.tools.get("ntfy_configure");
		expect(tool).toBeDefined();
		const result = (await tool?.execute("call-1", params, undefined, undefined, harness.ctx)) as {
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		};
		return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
	}

	function configPath(): string {
		return process.env["PI_NTFY_CONFIG_FILE"] as string;
	}

	it("starts listening when a topic is enabled from inside the session", async () => {
		const fetchMock = vi.fn(async () => streamResponse(['{"id":"1","event":"open"}\n']));
		vi.stubGlobal("fetch", fetchMock);

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		expect(fetchMock).not.toHaveBeenCalled();

		await harness.commands.get("ntfy")?.handler("enable demo-topic", harness.ctx);

		// Persisted for the next session, and live right now.
		expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toMatchObject({
			topic: "demo-topic",
			enabled: true,
		});
		await waitFor(() => fetchMock.mock.calls.length > 0);
	});

	it("stops listening when disabled, and remembers that choice", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		const fetchMock = vi.fn(async () => streamResponse(['{"id":"1","event":"open"}\n']));
		vi.stubGlobal("fetch", fetchMock);

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);
		await waitFor(() => fetchMock.mock.calls.length > 0);

		await harness.commands.get("ntfy")?.handler("disable", harness.ctx);

		const callsAfter = fetchMock.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(fetchMock.mock.calls.length).toBe(callsAfter);
		expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toMatchObject({ enabled: false });
	});

	it("applies /ntfy set to the running subscription", async () => {
		const fetchMock = vi.fn(async () => streamResponse(['{"id":"1","event":"open"}\n']));
		vi.stubGlobal("fetch", fetchMock);

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);

		await harness.commands.get("ntfy")?.handler("set topic demo-set", harness.ctx);
		await harness.commands.get("ntfy")?.handler("set minPriority 4", harness.ctx);

		expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toMatchObject({
			topic: "demo-set",
			minPriority: 4,
		});
		await waitFor(() => fetchMock.mock.calls.length > 0);
	});

	it("rejects an unknown /ntfy set key instead of writing it", async () => {
		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);

		await harness.commands.get("ntfy")?.handler("set topix demo", harness.ctx);

		expect(harness.notifications.at(-1)?.text).toContain("unknown key");
		expect(fs.existsSync(configPath())).toBe(false);
	});

	it("reports a failed config write instead of pretending it worked", async () => {
		// The config path is resolved when the session starts, so it has to be broken
		// *before* that — changing the env mid-session would not move the target.
		const blocked = path.join(tmpDir, "blocked");
		fs.writeFileSync(blocked, "not a directory");
		process.env["PI_NTFY_CONFIG_FILE"] = path.join(blocked, "c.json");

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);

		await harness.commands.get("ntfy")?.handler("enable demo", harness.ctx);

		const last = harness.notifications.at(-1);
		expect(last?.level).toBe("error");
		expect(last?.text).toContain("could not write");
	});

	it("lets the agent configure itself through the tool", async () => {
		const fetchMock = vi.fn(async () => streamResponse(['{"id":"1","event":"open"}\n']));
		vi.stubGlobal("fetch", fetchMock);

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);

		const set = await callTool(harness, { action: "set", topic: "agent-topic", minPriority: 3 });
		expect(set.isError).toBe(false);
		expect(set.text).toContain("agent-topic");
		await waitFor(() => fetchMock.mock.calls.length > 0);

		const get = await callTool(harness, { action: "get" });
		expect(get.text).toContain('"topic": "agent-topic"');
		expect(get.text).toContain('"minPriority": 3');
		expect(get.text).toContain('"connected"');
	});

	it("never returns the token in clear text from the tool", async () => {
		process.env["PI_NTFY_TOPIC"] = "demo";
		process.env["PI_NTFY_TOKEN"] = "agent-must-not-see-this";
		vi.stubGlobal("fetch", vi.fn(async () => streamResponse([])));

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);

		const result = await callTool(harness, { action: "get" });
		expect(result.text).not.toContain("agent-must-not-see-this");
		expect(result.text).toContain('"token": "set"');
	});

	it("tells the agent off when it enables without a topic", async () => {
		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);

		const result = await callTool(harness, { action: "set", enabled: true });

		expect(result.isError).toBe(true);
		expect(result.text).toContain("topic");
		// Nothing usable was written.
		expect(fs.existsSync(configPath())).toBe(false);
	});

	it("rejects a set call with no fields", async () => {
		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);

		const result = await callTool(harness, { action: "set" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Nothing to set");
	});

	it("picks up a config file written by an earlier session", async () => {
		fs.writeFileSync(configPath(), JSON.stringify({ topic: "from-file", enabled: true }));
		const fetchMock = vi.fn(async (_url: string) => streamResponse(['{"id":"1","event":"open"}\n']));
		vi.stubGlobal("fetch", fetchMock);

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);

		await waitFor(() => fetchMock.mock.calls.length > 0);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("from-file");
	});

	it("stays silent when the config file disables it", async () => {
		fs.writeFileSync(configPath(), JSON.stringify({ topic: "demo", enabled: false }));
		const fetchMock = vi.fn(async () => streamResponse([]));
		vi.stubGlobal("fetch", fetchMock);

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);

		expect(harness.notifications).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("ignores a corrupt config file without breaking the session", async () => {
		fs.writeFileSync(configPath(), "{ not json");
		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);

		// Same as unconfigured: quiet, but the tool still works and can repair the file.
		expect(harness.notifications).toEqual([]);

		const set = await callTool(harness, { action: "set", topic: "recovered" });
		expect(set.isError).toBe(false);
		expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toMatchObject({ topic: "recovered" });
	});

	it("a corrupt config file is discoverable on demand, not by nagging", async () => {
		fs.writeFileSync(configPath(), "{ not json");

		const harness = makeHarness();
		(await loadExtension())(harness.api);
		liveHarnesses.push(harness);
		await startSession(harness);

		// Starting up says nothing...
		expect(harness.notifications).toEqual([]);

		// ...but asking reports why the file was ignored.
		await harness.commands.get("ntfy")?.handler("", harness.ctx);
		expect(harness.notifications.at(-1)?.text).toContain("config file error");

		const get = await callTool(harness, { action: "get" });
		expect(get.text).toContain("configFileError");
		expect(get.text).toContain("not valid JSON");
	});
});
