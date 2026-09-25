# Design notes

This is the design brief `@4ier/pi-ntfy` was implemented against. It is kept in the repo because
the API and protocol facts below were **verified against a real pi installation and a real ntfy
server**, and they are the parts most likely to go stale — keep them honest when changing code.


A **pi extension** that subscribes to an [ntfy](https://ntfy.sh) topic and turns incoming
notifications into agent turns, so a running pi session can react to external alerts
(CI failures, cron jobs, NAS watchdogs, IoT events, …) without a human pasting anything.

Published as **`@4ier/pi-ntfy`** on npm and as **`4ier/pi-ntfy`** on GitHub.

---

## 1. Why this exists

The motivating use case: a long-running backup relay on a NAS/phone pushes alerts to an
ntfy topic when it stalls. A pi session on the operator's machine subscribes to that topic;
when an alert lands, pi wakes up, reads the alert, and works the documented runbook.

Without this, the operator is the message bus.

---

## 2. Hard requirements

1. **Never break pi.** Any network/parse/config error must be contained: log/notify, reconnect
   with exponential backoff + jitter, never throw out of an event handler, never block startup.
2. **Startup must not block on the network.** `session_start` returns immediately; the
   subscription runs in the background.
3. **No replay storms.** On (re)connect use `since=none` so historical messages are not
   replayed, and additionally de-duplicate by ntfy message `id` across reconnects and
   process restarts.
4. **No secrets in the repo.** Configuration is environment variables only.
5. **Idle vs streaming.** If the agent is idle → start a new turn. If the agent is mid-turn →
   deliver without killing the current work.
6. **Clean shutdown.** `session_shutdown` must abort the HTTP stream and any timers.

---

## 3. Verified pi extension facts

Confirmed against an installed pi; re-verify if the upstream extension API changes.

- An extension is a module with a **default-exported factory** receiving `ExtensionAPI`:
  ```ts
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
  export default function (pi: ExtensionAPI) { /* ... */ }
  ```
- Extensions are loaded via **jiti**, so TypeScript runs without a build step.
- Events used here: `pi.on("session_start", async (event, ctx) => …)`,
  `pi.on("session_shutdown", async (event, ctx) => …)`.
- Inject a message that participates in LLM context:
  ```ts
  pi.sendMessage(
    { customType: "ntfy", content: "…", display: true, details: { … } },
    { triggerTurn: true, deliverAs: "steer" },   // "steer" | "followUp" | "nextTurn"
  );
  ```
  `triggerTurn: true` → if the agent is idle, a model response starts immediately.
- Inject a real **user** message (appears as if typed): `pi.sendUserMessage(content, options?)`.
  It **always triggers a turn** when not streaming; when streaming you **must** pass
  `deliverAs` or it throws.
- `ctx.isIdle()` tells whether the agent is streaming; `ctx.hasPendingMessages()` is also available.
- UI: `ctx.ui.notify(text, "info" | "warning" | "error")`, `ctx.ui.setStatus(key, text)`.
- Durable extension data: `pi.appendEntry(customType, data)` (not sent to the LLM).
- Register a command: `pi.registerCommand("ntfy", { description, handler: async (args, ctx) => … })`.
- Node built-ins are available (`node:fs`, `node:path`, …); npm runtime deps belong in
  `dependencies` (pi installs with `--omit=dev`).
- Extensions auto-load from `~/.pi/agent/extensions/*.ts` or `~/.pi/agent/extensions/*/index.ts`.
  Ad-hoc testing: `pi -e ./path/to/extension.ts`.

---

## 4. ntfy protocol facts

**Subscribe (streaming NDJSON):**
```
GET {server}/{topic}/json?since=none
→ one JSON object per line, long-lived
   {"id":"…","time":1790355119,"event":"open"}
   {"id":"…","time":…,"event":"keepalive","topic":"…"}
   {"id":"AbC123","time":…,"event":"message","topic":"t","title":"…","message":"…",
    "priority":4,"tags":["rotating_light"],"click":"https://…"}
```
- `since=none` → only messages published after the subscription starts.
- Extra response fields that are useful: `title`, `message`, `priority` (1–5), `tags[]`,
  `click`, `actions[]`, `attachment{name,url,size,type,expires}`.
- Protected topics: send `Authorization: Bearer <token>`.
- Publishing (for the `/ntfy` self-test command):
  `POST {server}/{topic}` with body = message and headers `Title:`, `Priority:`, `Tags:`.

---

## 5. Configuration

All via environment variables (document them all in the README):

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PI_NTFY_TOPIC` | **yes** | — | ntfy topic to subscribe to. If unset, the extension loads in a disabled state and says so via `ctx.ui.notify` — it must not error. |
| `PI_NTFY_SERVER` | no | `https://ntfy.sh` | Base URL of the ntfy server |
| `PI_NTFY_TOKEN` | no | — | Bearer token for protected topics (subscribe and publish) |
| `PI_NTFY_MIN_PRIORITY` | no | `1` | Ignore messages below this priority (1–5) |
| `PI_NTFY_TAG_ALLOW` | no | — | Comma-separated tag allowlist; if set, only messages carrying one of these tags are delivered |
| `PI_NTFY_IDLE_DELIVERY` | no | `user` | `user` → `sendUserMessage`; `custom` → `sendMessage` with `customType: "ntfy"` |
| `PI_NTFY_STREAMING_DELIVERY` | no | `steer` | `steer` or `followUp` when the agent is busy |
| `PI_NTFY_MAX_RETRIES` | no | unlimited | Give up reconnecting after N failures (for tests) |
| `PI_NTFY_PROMPT_TEMPLATE` | no | see below | Template for the injected text. Placeholders: `{{title}}`, `{{message}}`, `{{topic}}`, `{{priority}}`, `{{tags}}`, `{{time}}`, `{{id}}`, `{{click}}` |
| `PI_NTFY_STATE_FILE` | no | `~/.pi/agent/ntfy-state.json` | Where processed message ids are persisted |
| `PI_NTFY_QUIET` | no | — | `1` → don't emit UI notifications for connection state changes |

Default template:
```
[ntfy] {{title}}
{{message}}
```

Keep the injected text **compact and self-describing**: the agent must be able to decide
what to do from the message alone (include topic, priority and tags when present).

---

## 6. Behaviour

### 6.1 Lifecycle
- `session_start` → read config, register `/ntfy` command, set status `ntfy: connecting…`,
  start the background subscriber. Return immediately.
- `session_shutdown` → abort the stream, clear timers, set status to `ntfy: stopped`.

### 6.2 Subscriber loop
- Connect with `fetch`, read the body as a stream, split on `\n`, `JSON.parse` each non-empty line.
- `event: "open"` → status `ntfy: connected`.
- `event: "keepalive"` → ignore.
- `event: "message"` → run the filter pipeline, then deliver.
- On any error / stream end → exponential backoff (equal jitter, so the first step is
  0.5-1s; doubling to a 60s cap). The attempt counter is reset only once a stream has stayed
  open for `stableStreamMs` (default 30s) — resetting on the response headers instead lets a
  server that accepts and immediately closes retry at a fixed interval forever.
  status `ntfy: reconnecting in Ns`, then reconnect. Log failures to stderr at most once per
  backoff step (do not spam).

### 6.3 Filter pipeline (in order, all pure and unit-testable)
1. drop if `event !== "message"`
2. drop if `priority < PI_NTFY_MIN_PRIORITY`
3. drop if `PI_NTFY_TAG_ALLOW` is set and the message's tags don't intersect it
4. drop if the message has no `id` (it cannot be de-duplicated, so it would be re-delivered
   on every reconnect) — added during implementation
5. drop if the message `id` was already processed (persisted set, capped at the most recent
   500 ids)
5. otherwise: mark processed (persist) → render the prompt → deliver

### 6.4 Delivery
- `ctx.isIdle()` → `sendUserMessage(prompt)` (or `sendMessage` when `PI_NTFY_IDLE_DELIVERY=custom`)
- else → `sendMessage(…, { deliverAs: PI_NTFY_STREAMING_DELIVERY, triggerTurn: true })`
- Any throw during delivery must be caught and surfaced via `ctx.ui.notify(…, "error")`.

### 6.5 `/ntfy` command
```
/ntfy                 → print status: topic, server, connected?, delivered count, last error
/ntfy test [message]  → publish a test message to the topic (proves the round trip)
/ntfy reconnect       → drop the current stream and reconnect now
/ntfy ids             → print how many ids are remembered
```

---

## 7. Repository layout

```
pi-ntfy/
  package.json          # name "pi-ntfy", type module, pi manifest, deps
  tsconfig.json         # strict, for typecheck only (jiti runs the TS directly)
  README.md             # install, config table, usage, security notes, limitations
  LICENSE               # MIT, author 4ier
  CHANGELOG.md
  .gitignore
  .github/workflows/ci.yml   # node 22: typecheck + test
  src/
    index.ts            # extension entry (default export factory)
    config.ts           # env parsing + defaults + validation
    ntfy.ts             # subscribe stream, publish helper, pure message parsing
    filter.ts           # the filter pipeline (pure)
    template.ts         # {{placeholder}} rendering (pure)
    state.ts            # persisted processed-id set (pure logic + fs adapter)
    log.ts              # stderr logging with a simple level gate
  test/
    filter.test.ts
    template.test.ts
    config.test.ts
    state.test.ts
    ntfy-parse.test.ts
```

`package.json` essentials:
```json
{
  "name": "pi-ntfy",
  "version": "0.1.0",
  "type": "module",
  "description": "pi extension: subscribe to an ntfy topic and turn notifications into agent turns",
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/4ier/pi-ntfy.git" },
  "keywords": ["pi", "pi-package", "pi-extension", "ntfy", "notifications", "agent"],
  "files": ["src", "README.md", "LICENSE", "CHANGELOG.md"],
  "pi": { "extensions": ["./src/index.ts"] },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typescript": "^5",
    "vitest": "^2"
  }
}
```

Notes:
- Prefer **zero runtime dependencies** (Node 22 has `fetch` and streams).
- `@earendil-works/pi-coding-agent` is a **devDependency** for types only — import it with
  `import type` so nothing is required at runtime.
- The `pi` manifest key must point at the extension entry so `pi install npm:pi-ntfy` works.

---

## 8. Testing

- Use **vitest** and run it in **non-watch mode** (`vitest run`); CI must exit non-zero on
  failure. **Never** use `-w`/`--watch` in automated verification.
- Unit-test the pure modules: filter pipeline (each rule in isolation + combinations),
  template rendering (missing placeholders, repeated placeholders, HTML-ish characters),
  config parsing (defaults, invalid numbers, missing topic), state (cap at 500, dedupe),
  NDJSON parsing (partial lines, blank lines, malformed JSON must not throw).
- Do **not** write tests that require network access or a real ntfy server.
- Target: every branch of `filter.ts`, `template.ts`, `config.ts`, `state.ts` covered.

---

## 9. Documentation requirements (README)

Must contain, in this order:

1. One-paragraph what/why
2. Install (`pi install npm:pi-ntfy` and `pi install git:github.com/4ier/pi-ntfy`, plus
   `pi -e ./src/index.ts` for local dev)
3. Quick start with a concrete example (publish with curl, watch the agent react)
4. Full configuration table (§5)
5. Commands (§6.5)
6. **Security**: anyone who can publish to the topic can drive the agent. Recommend:
   an unguessable topic name, a protected topic with `PI_NTFY_TOKEN`, and note that
   `PI_NTFY_TAG_ALLOW` can act as a shared-secret filter.
7. **Limitations**: it only works while a pi session is running; ntfy public topics are
   world-readable; message bodies are truncated to a sane length before injection.
8. Development: `npm i`, `npm run typecheck`, `npm test`.

---

## 10. Definition of done

- [ ] `npm run typecheck` clean
- [ ] `npm test` passes (vitest run, non-watch)
- [ ] `pi -e ./src/index.ts` loads without error (verify the command `/ntfy` is registered —
      at minimum confirm the module imports cleanly under node with the pi types stripped)
- [ ] No runtime dependencies
- [ ] README complete per §9, LICENSE present, CI workflow present
- [ ] `git` repo initialised with a clean first commit
- [ ] No secrets anywhere in the tree

## 11. Out of scope

- Keeping a CHANGELOG up to date for every patch release.
