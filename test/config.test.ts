import path from "node:path";

import { describe, expect, it } from "vitest";

import {
	DEFAULT_PROMPT_TEMPLATE,
	DEFAULT_SERVER,
	parseConfig,
	type EnvLike,
} from "../src/config.js";

const HOME = "/home/tester";

function parse(env: EnvLike = {}) {
	return parseConfig({ env, homeDir: HOME });
}

function withTopic(extra: EnvLike = {}) {
	return parse({ PI_NTFY_TOPIC: "demo", ...extra });
}

function parseBoth(env: EnvLike, fileEnv: EnvLike) {
	return parseConfig({ env, fileEnv, homeDir: HOME });
}

describe("parseConfig — topic", () => {
	it("is inert but NOT an error when no topic is configured", () => {
		// Changed in 0.2.0: a missing topic used to land in `errors`, which made every
		// unconfigured session print a warning. Not wanting an inbound alert channel is a
		// normal state, so it is reported through `reason` (debug-level) instead.
		const config = parse();
		expect(config.enabled).toBe(false);
		expect(config.configured).toBe(false);
		expect(config.source).toBe("none");
		expect(config.errors).toEqual([]);
		expect(config.reason).toContain("no topic configured");
	});

	it("is inert but NOT an error when the topic is blank", () => {
		const config = parse({ PI_NTFY_TOPIC: "   " });
		expect(config.enabled).toBe(false);
		expect(config.errors).toEqual([]);
	});

	it("accepts a normal topic", () => {
		const config = withTopic();
		expect(config.enabled).toBe(true);
		expect(config.topic).toBe("demo");
		expect(config.errors).toHaveLength(0);
	});

	it("trims surrounding whitespace", () => {
		expect(parse({ PI_NTFY_TOPIC: "  demo  " }).topic).toBe("demo");
	});

	it.each(["has space", "has/slash", "has.dot", "有中文", "x".repeat(65)])(
		"rejects the invalid topic %j",
		(topic) => {
			const config = parse({ PI_NTFY_TOPIC: topic });
			expect(config.enabled).toBe(false);
			expect(config.errors.join(" ")).toContain("not a valid ntfy topic");
		},
	);

	it("accepts a 64-character topic", () => {
		expect(parse({ PI_NTFY_TOPIC: "x".repeat(64) }).enabled).toBe(true);
	});
});

describe("parseConfig — server", () => {
	it("defaults to ntfy.sh", () => {
		expect(withTopic().server).toBe(DEFAULT_SERVER);
	});

	it("strips trailing slashes", () => {
		expect(withTopic({ PI_NTFY_SERVER: "https://ntfy.example.com///" }).server).toBe(
			"https://ntfy.example.com",
		);
	});

	it("accepts http for local servers", () => {
		expect(withTopic({ PI_NTFY_SERVER: "http://127.0.0.1:2586" }).server).toBe("http://127.0.0.1:2586");
	});

	it.each(["ntfy.sh", "ftp://ntfy.sh", "://nope"])("rejects the invalid server %j", (server) => {
		const config = withTopic({ PI_NTFY_SERVER: server });
		expect(config.enabled).toBe(false);
		expect(config.errors.join(" ")).toContain("must be an http(s) URL");
	});
});

describe("parseConfig — token", () => {
	it("is undefined by default", () => {
		expect(withTopic().token).toBeUndefined();
	});

	it("is trimmed", () => {
		expect(withTopic({ PI_NTFY_TOKEN: "  abc  " }).token).toBe("abc");
	});

	it("treats a blank token as absent", () => {
		expect(withTopic({ PI_NTFY_TOKEN: "   " }).token).toBeUndefined();
	});
});

describe("parseConfig — min priority", () => {
	it("defaults to 1", () => {
		expect(withTopic().minPriority).toBe(1);
	});

	it.each(["1", "3", "5"])("accepts %s", (value) => {
		expect(withTopic({ PI_NTFY_MIN_PRIORITY: value }).minPriority).toBe(Number(value));
	});

	it.each(["0", "6", "-1", "abc", "2.5", ""])("falls back to 1 for %j", (value) => {
		const config = withTopic({ PI_NTFY_MIN_PRIORITY: value });
		expect(config.minPriority).toBe(1);
		if (value !== "") {
			expect(config.warnings.join(" ")).toContain("PI_NTFY_MIN_PRIORITY");
		}
	});
});

describe("parseConfig — tag allowlist", () => {
	it("is null by default", () => {
		expect(withTopic().tagAllow).toBeNull();
	});

	it("splits and trims a comma list", () => {
		expect(withTopic({ PI_NTFY_TAG_ALLOW: " a , b ,c " }).tagAllow).toEqual(["a", "b", "c"]);
	});

	it("drops empty entries", () => {
		expect(withTopic({ PI_NTFY_TAG_ALLOW: "a,,b," }).tagAllow).toEqual(["a", "b"]);
	});

	it("falls back to null and warns when nothing usable remains", () => {
		const config = withTopic({ PI_NTFY_TAG_ALLOW: " , , " });
		expect(config.tagAllow).toBeNull();
		expect(config.warnings.join(" ")).toContain("contained no tags");
	});

	it("accepts a single tag", () => {
		expect(withTopic({ PI_NTFY_TAG_ALLOW: "gprelay" }).tagAllow).toEqual(["gprelay"]);
	});
});

describe("parseConfig — delivery modes", () => {
	it("defaults to user + steer", () => {
		const config = withTopic();
		expect(config.idleDelivery).toBe("user");
		expect(config.streamingDelivery).toBe("steer");
	});

	it("accepts the documented values", () => {
		const config = withTopic({
			PI_NTFY_IDLE_DELIVERY: "custom",
			PI_NTFY_STREAMING_DELIVERY: "followUp",
		});
		expect(config.idleDelivery).toBe("custom");
		expect(config.streamingDelivery).toBe("followUp");
	});

	it("warns and falls back for an unknown idle mode", () => {
		const config = withTopic({ PI_NTFY_IDLE_DELIVERY: "nope" });
		expect(config.idleDelivery).toBe("user");
		expect(config.warnings.join(" ")).toContain("PI_NTFY_IDLE_DELIVERY");
	});

	it("warns and falls back for an unknown streaming mode", () => {
		const config = withTopic({ PI_NTFY_STREAMING_DELIVERY: "nextTurn" });
		expect(config.streamingDelivery).toBe("steer");
		expect(config.warnings.join(" ")).toContain("PI_NTFY_STREAMING_DELIVERY");
	});
});

describe("parseConfig — retries", () => {
	it("defaults to unlimited", () => {
		expect(withTopic().maxRetries).toBeNull();
	});

	it("accepts zero (never retry)", () => {
		expect(withTopic({ PI_NTFY_MAX_RETRIES: "0" }).maxRetries).toBe(0);
	});

	it("accepts a positive count", () => {
		expect(withTopic({ PI_NTFY_MAX_RETRIES: "3" }).maxRetries).toBe(3);
	});

	it.each(["-1", "abc", "1.5"])("warns and falls back to unlimited for %j", (value) => {
		const config = withTopic({ PI_NTFY_MAX_RETRIES: value });
		expect(config.maxRetries).toBeNull();
		expect(config.warnings.join(" ")).toContain("PI_NTFY_MAX_RETRIES");
	});
});

describe("parseConfig — prompt template", () => {
	it("defaults to the shipped template", () => {
		expect(withTopic().promptTemplate).toBe(DEFAULT_PROMPT_TEMPLATE);
	});

	it("keeps a custom template verbatim", () => {
		const template = "ALERT {{title}}\n{{message}}\n";
		expect(withTopic({ PI_NTFY_PROMPT_TEMPLATE: template }).promptTemplate).toBe(template);
	});

	it("warns and falls back when the template is blank", () => {
		const config = withTopic({ PI_NTFY_PROMPT_TEMPLATE: "   " });
		expect(config.promptTemplate).toBe(DEFAULT_PROMPT_TEMPLATE);
		expect(config.warnings.join(" ")).toContain("PI_NTFY_PROMPT_TEMPLATE");
	});
});

describe("parseConfig — state file", () => {
	it("defaults under the home directory", () => {
		expect(withTopic().stateFile).toBe(path.join(HOME, ".pi", "agent", "ntfy-state.json"));
	});

	it("expands a leading tilde", () => {
		expect(withTopic({ PI_NTFY_STATE_FILE: "~/x/y.json" }).stateFile).toBe(path.join(HOME, "x/y.json"));
	});

	it("falls back to the default file for a bare tilde", () => {
		// A bare `~` expands to the home *directory*, which can never be written as a
		// state file. It used to be accepted silently, configuring a guaranteed no-op.
		const result = withTopic({ PI_NTFY_STATE_FILE: "~" });
		expect(result.stateFile).toBe(path.join(HOME, ".pi", "agent", "ntfy-state.json"));
		expect(result.warnings.join(" ")).toContain("resolves to a directory");
	});

	it("keeps an absolute path", () => {
		expect(withTopic({ PI_NTFY_STATE_FILE: "/var/lib/ntfy.json" }).stateFile).toBe("/var/lib/ntfy.json");
	});
});

describe("parseConfig — quiet", () => {
	it("is false by default", () => {
		expect(withTopic().quiet).toBe(false);
	});

	it.each(["1", "true", "TRUE", "yes", "on"])("accepts %j", (value) => {
		expect(withTopic({ PI_NTFY_QUIET: value }).quiet).toBe(true);
	});

	it.each(["0", "false", "no", "off", "maybe", ""])("rejects %j", (value) => {
		expect(withTopic({ PI_NTFY_QUIET: value }).quiet).toBe(false);
	});
});

describe("parseConfig — combined", () => {
	it("collects several errors at once", () => {
		const config = parse({ PI_NTFY_TOPIC: "bad topic", PI_NTFY_SERVER: "nope" });
		expect(config.enabled).toBe(false);
		expect(config.errors).toHaveLength(2);
	});

	it("produces warnings without disabling", () => {
		const config = withTopic({ PI_NTFY_MIN_PRIORITY: "9", PI_NTFY_MAX_RETRIES: "-2" });
		expect(config.enabled).toBe(true);
		expect(config.warnings.length).toBeGreaterThanOrEqual(2);
	});

	it("returns no diagnostics for a clean configuration", () => {
		const config = withTopic({
			PI_NTFY_MIN_PRIORITY: "4",
			PI_NTFY_TAG_ALLOW: "gprelay",
			PI_NTFY_IDLE_DELIVERY: "custom",
			PI_NTFY_STREAMING_DELIVERY: "followUp",
			PI_NTFY_MAX_RETRIES: "5",
			PI_NTFY_QUIET: "1",
		});
		expect(config.warnings).toEqual([]);
		expect(config.errors).toEqual([]);
		expect(config).toMatchObject({
			enabled: true,
			minPriority: 4,
			tagAllow: ["gprelay"],
			idleDelivery: "custom",
			streamingDelivery: "followUp",
			maxRetries: 5,
			quiet: true,
		});
	});
});

describe("parseConfig — env vs config file", () => {
	it("uses the file when the env is empty", () => {
		const config = parseBoth({}, { PI_NTFY_TOPIC: "from-file" });
		expect(config.enabled).toBe(true);
		expect(config.topic).toBe("from-file");
		expect(config.source).toBe("file");
	});

	it("lets the env win over the file", () => {
		// The env is the escape hatch for one-off and CI runs; it must not be shadowed.
		const config = parseBoth(
			{ PI_NTFY_TOPIC: "from-env", PI_NTFY_SERVER: "https://env.example" },
			{ PI_NTFY_TOPIC: "from-file", PI_NTFY_SERVER: "https://file.example" },
		);
		expect(config.topic).toBe("from-env");
		expect(config.server).toBe("https://env.example");
		expect(config.source).toBe("env");
	});

	it("fills in fields the env does not set from the file", () => {
		const config = parseBoth(
			{ PI_NTFY_TOPIC: "from-env" },
			{ PI_NTFY_MIN_PRIORITY: "4", PI_NTFY_TAG_ALLOW: "a,b" },
		);
		expect(config.minPriority).toBe(4);
		expect(config.tagAllow).toEqual(["a", "b"]);
	});

	it("does not let undefined env keys erase file values", () => {
		// process.env is full of undefined-valued keys; a naive spread would wipe the file.
		const config = parseBoth({ PI_NTFY_TOPIC: undefined }, { PI_NTFY_TOPIC: "from-file" });
		expect(config.topic).toBe("from-file");
		expect(config.source).toBe("file");
	});

	it("falls back to defaults when neither source sets a field", () => {
		const config = parseBoth({ PI_NTFY_TOPIC: "x" }, {});
		expect(config.server).toBe(DEFAULT_SERVER);
		expect(config.promptTemplate).toBe(DEFAULT_PROMPT_TEMPLATE);
	});

	it("rejects an invalid topic that came from the file", () => {
		const config = parseBoth({}, { PI_NTFY_TOPIC: "has spaces" });
		expect(config.enabled).toBe(false);
		expect(config.configured).toBe(true);
		expect(config.errors.join(" ")).toContain("not a valid ntfy topic");
	});

	it("treats an invalid env topic as the configured-but-broken case", () => {
		const config = parseBoth({ PI_NTFY_TOPIC: "has spaces" }, {});
		expect(config.source).toBe("env");
		expect(config.errors).toHaveLength(1);
	});
});
