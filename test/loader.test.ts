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

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(projectRoot, "src", "index.ts");

interface PackageManifest {
	pi?: { extensions?: string[] };
}

function readManifest(): PackageManifest {
	return JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as PackageManifest;
}

function freshJiti(): ReturnType<typeof createJiti> {
	return createJiti(projectRoot, { moduleCache: false });
}

describe("jiti loads the extension entry the way pi does", () => {
	it("the pi manifest points at a file that exists", () => {
		// Nothing else covers this. `pi install` resolves the extension path from the
		// package.json `pi.extensions` entry, so a typo there (`./src/index.js`, a moved
		// file) would keep every test and the CI smoke step green while the package is
		// uninstallable.
		const declared = readManifest().pi?.extensions;
		expect(declared).toEqual(["./src/index.ts"]);
		for (const relative of declared ?? []) {
			expect(fs.existsSync(path.join(projectRoot, relative)), `${relative} must exist`).toBe(true);
		}
		// and the declared path must be the same file this suite loads directly
		expect(path.resolve(projectRoot, declared?.[0] ?? "")).toBe(path.resolve(entry));
	});

	it("resolves src/index.ts and its .js relative specifiers", async () => {
		const factory = await freshJiti().import(entry, { default: true });
		expect(typeof factory).toBe("function");
	});

	it("loads through the path declared in the manifest, not just a hardcoded one", async () => {
		const declared = readManifest().pi?.extensions ?? [];
		for (const relative of declared) {
			const factory = await freshJiti().import(path.join(projectRoot, relative), { default: true });
			expect(typeof factory).toBe("function");
		}
	});

	it("the factory registers exactly the handlers, command and tool the docs promise", async () => {
		const factory = (await freshJiti().import(entry, { default: true })) as (
			api: ExtensionAPI,
		) => void;

		const handlers = new Set<string>();
		const commands = new Set<string>();
		const tools = new Set<string>();

		// Minimal stub: at load time the factory only touches `on`, `registerCommand`
		// and `registerTool`.
		const api = {
			on: (name: string) => {
				handlers.add(name);
			},
			registerCommand: (name: string) => {
				commands.add(name);
			},
			registerTool: (definition: { name: string }) => {
				tools.add(definition.name);
			},
		} as unknown as ExtensionAPI;

		factory(api);

		expect([...handlers].sort()).toEqual(["session_shutdown", "session_start"]);
		expect([...commands]).toEqual(["ntfy"]);
		// Registered at load time so the agent can configure alerts in a session that
		// started with nothing configured.
		expect([...tools]).toEqual(["ntfy_configure"]);
	});
});
