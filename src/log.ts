/**
 * Minimal stderr logger with a level gate.
 *
 * Deliberately dependency-free and side-effect free at import time: an extension
 * must never be able to break pi startup just by being loaded.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogSink = (line: string) => void;

export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

export const PREFIX = "[pi-ntfy]";

function defaultSink(line: string): void {
	try {
		process.stderr.write(`${line}\n`);
	} catch {
		// stderr can be closed during shutdown; never propagate.
	}
}

/**
 * Create a logger that writes `[pi-ntfy] <level> <message>` to stderr.
 *
 * @param minLevel lowest level that is actually emitted
 * @param sink override for tests
 */
export function createLogger(minLevel: LogLevel = "info", sink: LogSink = defaultSink): Logger {
	const threshold = LEVEL_ORDER[minLevel];

	const emit = (level: LogLevel, message: string): void => {
		if (LEVEL_ORDER[level] < threshold) {
			return;
		}
		try {
			sink(`${PREFIX} ${level} ${message}`);
		} catch {
			// A broken sink must not take down the caller.
		}
	};

	return {
		debug: (message) => emit("debug", message),
		info: (message) => emit("info", message),
		warn: (message) => emit("warn", message),
		error: (message) => emit("error", message),
	};
}
