import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendCapped, loadIds, makeIdSet, saveIds } from "../src/state.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ntfy-state-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function statePath(name = "state.json"): string {
	return path.join(tmpDir, name);
}

describe("appendCapped", () => {
	it("appends to an empty list", () => {
		expect(appendCapped([], "a", 500)).toEqual(["a"]);
	});

	it("appends in order", () => {
		expect(appendCapped(["a", "b"], "c", 500)).toEqual(["a", "b", "c"]);
	});

	it("moves an existing id to the end instead of duplicating it", () => {
		expect(appendCapped(["a", "b", "c"], "a", 500)).toEqual(["b", "c", "a"]);
	});

	it("drops the oldest entries beyond the cap", () => {
		expect(appendCapped(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
	});

	it("keeps the most recent N after a re-add that overflows", () => {
		expect(appendCapped(["a", "b", "c"], "b", 2)).toEqual(["c", "b"]);
	});

	it("does not trim when a re-add lands exactly on the cap", () => {
		expect(appendCapped(["a", "b", "c"], "b", 3)).toEqual(["a", "c", "b"]);
	});

	it("returns an empty list for a zero cap", () => {
		expect(appendCapped(["a"], "b", 0)).toEqual([]);
	});

	it("returns an empty list for a negative cap", () => {
		expect(appendCapped(["a"], "b", -5)).toEqual([]);
	});

	it("does not mutate the input", () => {
		const input = ["a"];
		appendCapped(input, "b", 500);
		expect(input).toEqual(["a"]);
	});

	it("never grows past the cap over many inserts", () => {
		let ids: string[] = [];
		for (let i = 0; i < 1200; i += 1) {
			ids = appendCapped(ids, `id-${i}`, 500);
		}
		expect(ids).toHaveLength(500);
		expect(ids.at(-1)).toBe("id-1199");
		expect(ids.at(0)).toBe("id-700");
	});
});

describe("makeIdSet", () => {
	it("builds a lookup set", () => {
		const set = makeIdSet(["a", "b"]);
		expect(set.has("a")).toBe(true);
		expect(set.has("c")).toBe(false);
		expect(set.size).toBe(2);
	});

	it("handles duplicates", () => {
		expect(makeIdSet(["a", "a"]).size).toBe(1);
	});
});

describe("loadIds", () => {
	it("returns an empty list for a missing file without an error", () => {
		expect(loadIds(statePath("nope.json"))).toEqual({ ids: [], error: undefined });
	});

	it("reads the wrapped object shape", () => {
		const file = statePath();
		fs.writeFileSync(file, JSON.stringify({ ids: ["a", "b"] }));
		expect(loadIds(file).ids).toEqual(["a", "b"]);
	});

	it("reads a bare array", () => {
		const file = statePath();
		fs.writeFileSync(file, JSON.stringify(["a"]));
		expect(loadIds(file).ids).toEqual(["a"]);
	});

	it("treats an empty file as no ids", () => {
		const file = statePath();
		fs.writeFileSync(file, "   \n");
		expect(loadIds(file)).toEqual({ ids: [], error: undefined });
	});

	it("reports malformed JSON instead of throwing", () => {
		const file = statePath();
		fs.writeFileSync(file, "{not json");
		const result = loadIds(file);
		expect(result.ids).toEqual([]);
		expect(result.error).toBeDefined();
	});

	it("ignores non-string entries", () => {
		const file = statePath();
		fs.writeFileSync(file, JSON.stringify({ ids: ["a", 1, null, "b"] }));
		expect(loadIds(file).ids).toEqual(["a", "b"]);
	});

	it("returns no ids for an unexpected shape", () => {
		const file = statePath();
		fs.writeFileSync(file, JSON.stringify({ something: "else" }));
		expect(loadIds(file)).toEqual({ ids: [], error: undefined });
	});

	it("refuses to read an oversized file", () => {
		const file = statePath();
		fs.writeFileSync(file, "x".repeat(2048));
		const result = loadIds(file, 1024);
		expect(result.ids).toEqual([]);
		expect(result.error).toContain("refusing to read");
	});

	it("reports a directory instead of a file", () => {
		const dir = path.join(tmpDir, "adir");
		fs.mkdirSync(dir);
		const result = loadIds(dir);
		expect(result.ids).toEqual([]);
		expect(result.error).toContain("not a regular file");
	});
});

describe("saveIds", () => {
	it("round-trips through loadIds", () => {
		const file = statePath();
		const saved = saveIds(file, ["a", "b"]);
		expect(saved.ok).toBe(true);
		expect(loadIds(file).ids).toEqual(["a", "b"]);
	});

	it("creates missing parent directories", () => {
		const file = path.join(tmpDir, "deep", "nested", "state.json");
		expect(saveIds(file, ["a"]).ok).toBe(true);
		expect(fs.existsSync(file)).toBe(true);
	});

	it("writes the file with owner-only permissions", () => {
		const file = statePath();
		saveIds(file, ["a"]);
		const mode = fs.statSync(file).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("overwrites previous contents", () => {
		const file = statePath();
		saveIds(file, ["a", "b", "c"]);
		saveIds(file, ["z"]);
		expect(loadIds(file).ids).toEqual(["z"]);
	});

	it("leaves no temp files behind", () => {
		const file = statePath();
		saveIds(file, ["a"]);
		expect(fs.readdirSync(tmpDir)).toEqual(["state.json"]);
	});

	it("reports a failure instead of throwing", () => {
		// a path whose parent is a file, not a directory
		const blocker = statePath("blocker");
		fs.writeFileSync(blocker, "x");
		const result = saveIds(path.join(blocker, "child.json"), ["a"]);
		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("writes an empty list", () => {
		const file = statePath();
		expect(saveIds(file, []).ok).toBe(true);
		expect(loadIds(file).ids).toEqual([]);
	});
});
