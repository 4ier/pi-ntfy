import { describe, expect, it } from "vitest";

import { MAX_BODY_CHARS, MAX_META_CHARS, MAX_TITLE_CHARS } from "../src/config.js";
import type { NtfyMessage } from "../src/ntfy.js";
import { buildTemplateVars, renderTemplate, truncate } from "../src/template.js";

function message(overrides: Partial<NtfyMessage> = {}): NtfyMessage {
	return {
		id: "AbC123",
		time: 1_790_355_119,
		topic: "demo",
		title: "Backup stalled",
		message: "ledger has not moved for 3 hours",
		priority: 4,
		tags: ["rotating_light", "gprelay"],
		click: "https://example.com/runbook",
		...overrides,
	};
}

describe("renderTemplate", () => {
	it("substitutes known placeholders", () => {
		expect(renderTemplate("[{{title}}] {{message}}", { title: "T", message: "M" })).toBe("[T] M");
	});

	it("tolerates whitespace inside the braces", () => {
		expect(renderTemplate("{{ title }}|{{  message  }}", { title: "T", message: "M" })).toBe("T|M");
	});

	it("renders unknown placeholders as empty strings", () => {
		expect(renderTemplate("a{{nope}}b", { title: "T" })).toBe("ab");
	});

	it("renders missing values as empty strings", () => {
		expect(renderTemplate("a{{title}}b", {})).toBe("ab");
	});

	it("treats null and undefined the same", () => {
		expect(renderTemplate("{{a}}/{{b}}", { a: null, b: undefined })).toBe("/");
	});

	it("coerces numbers", () => {
		expect(renderTemplate("p={{priority}}", { priority: 4 })).toBe("p=4");
	});

	it("replaces repeated placeholders everywhere", () => {
		expect(renderTemplate("{{x}}-{{x}}-{{x}}", { x: "1" })).toBe("1-1-1");
	});

	it("leaves text without placeholders untouched", () => {
		expect(renderTemplate("plain text", {})).toBe("plain text");
	});

	it("does not interpret single braces", () => {
		expect(renderTemplate("{title} {{title}}", { title: "T" })).toBe("{title} T");
	});

	it("passes through HTML-ish characters verbatim", () => {
		const rendered = renderTemplate("{{message}}", { message: '<b>&"quoted"</b>' });
		expect(rendered).toBe('<b>&"quoted"</b>');
	});

	it("does not recurse into substituted values", () => {
		expect(renderTemplate("{{a}}", { a: "{{b}}", b: "x" })).toBe("{{b}}");
	});

	it("handles an empty template", () => {
		expect(renderTemplate("", { a: "x" })).toBe("");
	});
});

describe("truncate", () => {
	it("leaves short text alone", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	it("keeps text of exactly the limit", () => {
		expect(truncate("hello", 5)).toBe("hello");
	});

	it("appends a marker describing what was dropped", () => {
		const result = truncate("abcdefghij", 4);
		expect(result.startsWith("abcd")).toBe(true);
		expect(result).toContain("6 chars truncated");
	});

	it("returns an empty string for a non-positive limit", () => {
		expect(truncate("hello", 0)).toBe("");
		expect(truncate("hello", -1)).toBe("");
	});
});

describe("buildTemplateVars", () => {
	it("maps every documented placeholder", () => {
		const vars = buildTemplateVars(message());
		expect(vars["id"]).toBe("AbC123");
		expect(vars["topic"]).toBe("demo");
		expect(vars["title"]).toBe("Backup stalled");
		expect(vars["message"]).toBe("ledger has not moved for 3 hours");
		expect(vars["priority"]).toBe("4");
		expect(vars["tags"]).toBe("rotating_light,gprelay");
		expect(vars["click"]).toBe("https://example.com/runbook");
		expect(vars["time"]).toBe(new Date(1_790_355_119_000).toISOString());
	});

	it("renders missing click as an empty string", () => {
		expect(buildTemplateVars(message({ click: undefined }))["click"]).toBe("");
	});

	it("renders empty tags as an empty string", () => {
		expect(buildTemplateVars(message({ tags: [] }))["tags"]).toBe("");
	});

	it("truncates an oversized body", () => {
		const huge = "x".repeat(MAX_BODY_CHARS + 500);
		const vars = buildTemplateVars(message({ message: huge }));
		expect(vars["message"]?.length).toBeLessThan(huge.length);
		expect(vars["message"]).toContain("chars truncated");
	});

	it("truncates an oversized title, tag list and click URL", () => {
		// Regression: only the body was clamped, so a multi-megabyte title (or tag
		// list, or click URL) was a free path into the context window.
		const huge = "x".repeat(50_000);
		const vars = buildTemplateVars(
			message({ title: huge, tags: Array.from({ length: 5000 }, () => "tag"), click: huge }),
		);
		expect(vars["title"]?.length).toBeLessThan(MAX_TITLE_CHARS + 100);
		expect(vars["title"]).toContain("chars truncated");
		expect(vars["tags"]?.length).toBeLessThanOrEqual(MAX_META_CHARS + 100);
		expect(vars["click"]?.length).toBeLessThanOrEqual(MAX_META_CHARS + 100);
	});

	it("renders a zero timestamp as an empty string", () => {
		expect(buildTemplateVars(message({ time: 0 }))["time"]).toBe("");
	});

	it("renders a non-finite timestamp as an empty string", () => {
		expect(buildTemplateVars(message({ time: Number.NaN }))["time"]).toBe("");
	});

	it("composes with renderTemplate using the shipped default template", () => {
		const vars = buildTemplateVars(message());
		const rendered = renderTemplate("[ntfy] {{title}}\n{{message}}", vars);
		expect(rendered).toBe("[ntfy] Backup stalled\nledger has not moved for 3 hours");
	});
});
