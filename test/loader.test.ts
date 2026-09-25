/**
 * Production-loader test.
 *
 * Why this file exists: pi loads extensions with **jiti**, and this extension's source uses
 * NodeNext-style `.js` specifiers for its relative imports (`./config.js`, which must resolve
 * to `config.ts`). Neither of the other two test layers covers that resolution:
 *
 *   - the unit/integration tests import `../src/index.js` through **vitest's** resolver, and
 *   - the CI smoke step only imports the **compiled** output, which is plain JS.
 *
 * So without this file, `.js` -> `.ts` resolution — the one thing that decides whether
 * `pi install` works at all — is untested. This loads the real entry through the real loader.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(projectRoot, "src", "index.ts");

function freshJiti(): ReturnType<typeof createJiti> {
	return createJiti(projectRoot, { moduleCache: false });
}

describe("jiti loads the extension entry the way pi does", () => {
	it("resolves src/index.ts and its .js relative specifiers", async () => {
		const factory = await freshJiti().import(entry, { default: true });
		expect(typeof factory).toBe("function");
	});

	it("the factory registers exactly the handlers and command the docs promise", async () => {
		const factory = (await freshJiti().import(entry, { default: true })) as (
			api: ExtensionAPI,
		) => void;

		const handlers = new Set<string>();
		const commands = new Set<string>();

		// Minimal stub: the factory only touches `on` and `registerCommand` at load time.
		const api = {
			on: (name: string) => {
				handlers.add(name);
			},
			registerCommand: (name: string) => {
				commands.add(name);
			},
		} as unknown as ExtensionAPI;

		factory(api);

		expect([...handlers].sort()).toEqual(["session_shutdown", "session_start"]);
		expect([...commands]).toEqual(["ntfy"]);
	});
});
