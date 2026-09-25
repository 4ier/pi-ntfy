import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	configFilePath,
	describeSecret,
	expandVars,
	isKnownKey,
	parseConfigFile,
	readConfigFile,
	toEnvLike,
	writeConfigFile,
} from "../src/configFile.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ntfy-cfg-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("configFilePath", () => {
	it("defaults to ~/.pi/agent/pi-ntfy.json", () => {
		expect(configFilePath({}, "/home/x")).toBe("/home/x/.pi/agent/pi-ntfy.json");
	});

	it("honours PI_NTFY_CONFIG_FILE", () => {
		expect(configFilePath({ PI_NTFY_CONFIG_FILE: "/etc/ntfy.json" }, "/home/x")).toBe("/etc/ntfy.json");
	});

	it("expands a leading ~/", () => {
		expect(configFilePath({ PI_NTFY_CONFIG_FILE: "~/ntfy.json" }, "/home/x")).toBe("/home/x/ntfy.json");
	});

	it("falls back for a bare ~, which would name a directory", () => {
		expect(configFilePath({ PI_NTFY_CONFIG_FILE: "~" }, "/home/x")).toBe("/home/x/.pi/agent/pi-ntfy.json");
	});

	it("ignores a blank value", () => {
		expect(configFilePath({ PI_NTFY_CONFIG_FILE: "   " }, "/home/x")).toBe("/home/x/.pi/agent/pi-ntfy.json");
	});
});

describe("expandVars", () => {
	it("expands $VAR and ${VAR}", () => {
		expect(expandVars("$TOK", { TOK: "abc" })).toBe("abc");
		expect(expandVars("${TOK}", { TOK: "abc" })).toBe("abc");
	});

	it("leaves an unknown reference verbatim so the mistake is visible", () => {
		expect(expandVars("$NOPE", {})).toBe("$NOPE");
	});

	it("only expands when the reference is the whole value", () => {
		// Partial substitution would silently rewrite a prompt template containing a `$`.
		expect(expandVars("prefix-$TOK", { TOK: "abc" })).toBe("prefix-$TOK");
		expect(expandVars("$TOK-suffix", { TOK: "abc" })).toBe("$TOK-suffix");
	});

	it("leaves plain text alone", () => {
		expect(expandVars("just text", { TOK: "abc" })).toBe("just text");
	});
});

describe("toEnvLike", () => {
	it("maps every documented field", () => {
		const env = toEnvLike(
			{
				topic: "demo",
				server: "https://ntfy.example",
				token: "$TOK",
				minPriority: 3,
				tagAllow: ["a", "b"],
				idleDelivery: "custom",
				streamingDelivery: "followUp",
				maxRetries: 2,
				promptTemplate: "T",
				stateFile: "/tmp/s.json",
				quiet: true,
			},
			{ TOK: "resolved" },
		);
		expect(env).toEqual({
			PI_NTFY_TOPIC: "demo",
			PI_NTFY_SERVER: "https://ntfy.example",
			PI_NTFY_TOKEN: "resolved",
			PI_NTFY_MIN_PRIORITY: "3",
			PI_NTFY_TAG_ALLOW: "a,b",
			PI_NTFY_IDLE_DELIVERY: "custom",
			PI_NTFY_STREAMING_DELIVERY: "followUp",
			PI_NTFY_MAX_RETRIES: "2",
			PI_NTFY_PROMPT_TEMPLATE: "T",
			PI_NTFY_STATE_FILE: "/tmp/s.json",
			PI_NTFY_QUIET: "1",
		});
	});

	it("accepts a comma-separated tag string as well as an array", () => {
		expect(toEnvLike({ tagAllow: "a, b" }, {})["PI_NTFY_TAG_ALLOW"]).toBe("a, b");
	});

	it("omits fields that are absent or empty", () => {
		expect(toEnvLike({}, {})).toEqual({});
		expect(toEnvLike({ topic: "" }, {})).toEqual({});
		expect(toEnvLike({ tagAllow: [] }, {})).toEqual({});
	});

	it("ignores values of the wrong type instead of stringifying them", () => {
		// `topic: {"a":1}` must not become "[object Object]" and look configured.
		expect(toEnvLike({ topic: { a: 1 } }, {})).toEqual({});
		expect(toEnvLike({ minPriority: Number.NaN }, {})).toEqual({});
	});

	it("treats quiet:false as absent rather than as an explicit off", () => {
		expect(toEnvLike({ quiet: false }, {})).toEqual({});
	});
});

describe("parseConfigFile", () => {
	it("parses an object", () => {
		expect(parseConfigFile('{"topic":"demo"}')).toEqual({ values: { topic: "demo" }, error: undefined });
	});

	it("treats an empty file as empty config, not an error", () => {
		expect(parseConfigFile("   ")).toEqual({ values: {}, error: undefined });
	});

	it("reports bad JSON without throwing", () => {
		const result = parseConfigFile("{oops");
		expect(result.values).toEqual({});
		expect(result.error).toContain("not valid JSON");
	});

	it("rejects a non-object root", () => {
		expect(parseConfigFile("[1,2]").error).toContain("expected a JSON object");
		expect(parseConfigFile('"text"').error).toContain("expected a JSON object");
		expect(parseConfigFile("null").error).toContain("expected a JSON object");
	});
});

describe("readConfigFile", () => {
	it("reports absence without an error", () => {
		const result = readConfigFile(path.join(tmpDir, "nope.json"));
		expect(result.exists).toBe(false);
		expect(result.error).toBeUndefined();
		expect(result.env).toEqual({});
		expect(result.disabled).toBe(false);
	});

	it("reads and maps a present file", () => {
		const file = path.join(tmpDir, "c.json");
		fs.writeFileSync(file, JSON.stringify({ topic: "demo", enabled: true }));
		const result = readConfigFile(file, {});
		expect(result.exists).toBe(true);
		expect(result.disabled).toBe(false);
		expect(result.env["PI_NTFY_TOPIC"]).toBe("demo");
	});

	it("detects an explicit disable", () => {
		const file = path.join(tmpDir, "c.json");
		fs.writeFileSync(file, JSON.stringify({ topic: "demo", enabled: false }));
		expect(readConfigFile(file, {}).disabled).toBe(true);
	});

	it("degrades to an empty config on bad JSON", () => {
		const file = path.join(tmpDir, "c.json");
		fs.writeFileSync(file, "{not json");
		const result = readConfigFile(file, {});
		expect(result.error).toContain("not valid JSON");
		expect(result.env).toEqual({});
		// A broken file must be no worse than no file.
		expect(result.disabled).toBe(false);
	});

	it("degrades to an empty config when the path is a directory", () => {
		const result = readConfigFile(tmpDir, {});
		expect(result.error).toBeDefined();
		expect(result.env).toEqual({});
	});
});

describe("writeConfigFile", () => {
	it("creates the file and its parent directories", () => {
		const file = path.join(tmpDir, "deep", "nested", "c.json");
		expect(writeConfigFile(file, { topic: "demo" }).ok).toBe(true);
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ topic: "demo" });
	});

	it("merges into an existing file and preserves unknown keys", () => {
		const file = path.join(tmpDir, "c.json");
		fs.writeFileSync(file, JSON.stringify({ topic: "old", somethingElse: 42 }));
		expect(writeConfigFile(file, { topic: "new", minPriority: 4 }).ok).toBe(true);
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
			somethingElse: 42,
			topic: "new",
			minPriority: 4,
		});
	});

	it("refuses to clobber a file it cannot read", () => {
		// A directory is the portable way to get a deterministic read failure.
		const result = writeConfigFile(tmpDir, { topic: "demo" });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("cannot read");
	});

	it("reports a write failure instead of throwing", () => {
		const file = path.join(tmpDir, "blocked", "c.json");
		// Make the parent a file so mkdir -p fails.
		fs.writeFileSync(path.join(tmpDir, "blocked"), "not a directory");
		const result = writeConfigFile(file, { topic: "demo" });
		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("writes the file with owner-only permissions", () => {
		const file = path.join(tmpDir, "c.json");
		writeConfigFile(file, { topic: "demo", token: "secret" });
		const mode = fs.statSync(file).mode & 0o777;
		expect(mode).toBe(0o600);
	});
});

describe("describeSecret / isKnownKey", () => {
	it("never reveals the value", () => {
		expect(describeSecret("hunter2")).toBe("set");
		expect(describeSecret("")).toBe("unset");
		expect(describeSecret(undefined)).toBe("unset");
	});

	it("accepts documented keys and rejects typos", () => {
		expect(isKnownKey("topic")).toBe(true);
		expect(isKnownKey("promptTemplate")).toBe(true);
		expect(isKnownKey("topics")).toBe(false);
		expect(isKnownKey("__proto__")).toBe(false);
	});
});
