/**
 * `{{placeholder}}` rendering (pure).
 *
 * Contract:
 *  - placeholders may contain surrounding whitespace: `{{ title }}` works
 *  - an unknown or missing placeholder renders as the empty string, so a typo in a
 *    template degrades into "less information" instead of leaking `{{typo}}` text
 *    into the conversation
 *  - values are inserted verbatim (no HTML/Markdown escaping) — this text is fed to
 *    a model, not a browser
 */

import { MAX_BODY_CHARS, MAX_META_CHARS, MAX_TITLE_CHARS } from "./config.js";
import type { NtfyMessage } from "./ntfy.js";

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export type TemplateVars = Record<string, string | number | undefined | null>;

export function renderTemplate(template: string, vars: TemplateVars): string {
	return template.replace(PLACEHOLDER_RE, (_match, key: string) => {
		const value = vars[key];
		if (value === undefined || value === null) {
			return "";
		}
		return String(value);
	});
}

/**
 * Shorten `text` to at most `max` characters.
 *
 * An ntfy message may carry a very large body (or an attachment note); the injected
 * prompt must stay bounded so a single alert cannot blow up the context window.
 */
export function truncate(text: string, max: number): string {
	if (max <= 0) {
		return "";
	}
	if (text.length <= max) {
		return text;
	}
	const omitted = text.length - max;
	return `${text.slice(0, max)}… [+${omitted} chars truncated]`;
}

function formatTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return "";
	}
	try {
		return new Date(seconds * 1000).toISOString();
	} catch {
		return "";
	}
}

export function buildTemplateVars(msg: NtfyMessage): Record<string, string> {
	return {
		id: msg.id,
		topic: msg.topic,
		// Every interpolated value is clamped. Only clamping the body would leave a
		// multi-megabyte title (or tag list, or click URL) as a free path into the
		// context window.
		title: truncate(msg.title, MAX_TITLE_CHARS),
		message: truncate(msg.message, MAX_BODY_CHARS),
		priority: String(msg.priority),
		tags: truncate(msg.tags.join(","), MAX_META_CHARS),
		time: formatTime(msg.time),
		click: truncate(msg.click ?? "", MAX_META_CHARS),
	};
}
