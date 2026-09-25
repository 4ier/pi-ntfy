# pi-ntfy

A [pi](https://github.com/earendil-works/pi) extension that subscribes to an
[ntfy](https://ntfy.sh) topic and turns incoming notifications into agent turns.

Publish an alert from anywhere — a cron job, a CI pipeline, a NAS watchdog, your phone —
and a running pi session wakes up, reads it, and works the runbook. No copy-paste, no
"the operator is the message bus".

```text
   your script ──HTTP POST──► ntfy topic ──stream──► pi-ntfy ──► pi agent turn
```

## Install

```bash
# from npm
pi install npm:@4ier/pi-ntfy

# from git
pi install git:github.com/4ier/pi-ntfy

# try it without installing (temporary, current run only)
pi -e ./src/index.ts
```

Then export `PI_NTFY_TOPIC` (and friends) in the environment pi runs in, and start pi.

## Quick start

Pick an unguessable topic name and subscribe to it:

```bash
export PI_NTFY_TOPIC="my-agent-9f3c1a7e2b"
pi
```

In another terminal, publish something:

```bash
curl -d "build #1841 failed on main" \
     -H "Title: CI" -H "Priority: 4" -H "Tags: rotating_light" \
     "https://ntfy.sh/my-agent-9f3c1a7e2b"
```

The pi session immediately starts a turn with:

```
[ntfy] CI
build #1841 failed on main
```

Send `/ntfy test hello` inside pi to prove the round trip end to end.

## Configuration

Everything is environment variables. Nothing is written to the repo.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PI_NTFY_TOPIC` | **yes** | — | Topic to subscribe to. 1–64 chars of `A-Za-z0-9_-`. If unset, the extension loads **disabled** and says so — it never errors. |
| `PI_NTFY_SERVER` | no | `https://ntfy.sh` | Base URL of the ntfy server (self-hosted works, `http://` allowed). |
| `PI_NTFY_TOKEN` | no | — | Bearer token, for protected topics (used for both subscribe and publish). |
| `PI_NTFY_MIN_PRIORITY` | no | `1` | Drop messages below this ntfy priority (1–5). |
| `PI_NTFY_TAG_ALLOW` | no | — | Comma-separated tag allowlist. When set, only messages carrying one of these tags are delivered. |
| `PI_NTFY_IDLE_DELIVERY` | no | `user` | `user` → a normal user message; `custom` → an extension-authored message (`customType: "ntfy"`). |
| `PI_NTFY_STREAMING_DELIVERY` | no | `steer` | `steer` or `followUp` when the agent is mid-turn. |
| `PI_NTFY_MAX_RETRIES` | no | unlimited | Number of reconnect **retries** allowed after a failed connection before giving up (`0` = never retry at all). |
| `PI_NTFY_PROMPT_TEMPLATE` | no | see below | Template for the injected text. |
| `PI_NTFY_STATE_FILE` | no | `~/.pi/agent/ntfy-state.json` | Where processed message ids are remembered. `~` is expanded. |
| `PI_NTFY_QUIET` | no | — | `1`/`true`/`yes`/`on` → suppress UI notifications for connection state changes. |

Default template:

```
[ntfy] {{title}}
{{message}}
```

Available placeholders: `{{id}}`, `{{topic}}`, `{{title}}`, `{{message}}`, `{{priority}}`,
`{{tags}}`, `{{time}}` (ISO-8601), `{{click}}`. An unknown placeholder renders as the empty
string, so a typo degrades into less information rather than leaking `{{typo}}` into the
conversation.

Example — hand the agent a runbook hint:

```bash
export PI_NTFY_PROMPT_TEMPLATE='[{{topic}} p{{priority}}] {{title}}
{{message}}
{{click}}
Investigate, then fix it. If you cannot fix it automatically, explain why and stop.'
```

## Commands

| Command | Effect |
|---|---|
| `/ntfy` | Show status: topic, server, connected?, delivered count, remembered ids, last error |
| `/ntfy test [message]` | Publish a test message to the topic (proves the round trip) |
| `/ntfy reconnect` | Drop the current stream and reconnect now |
| `/ntfy ids` | How many processed message ids are remembered |

## Behaviour

- **Idle** → the message starts a new turn.
- **Busy** → delivered as `steer` (default) or `followUp`, so it never kills work in flight.
  Note `ctx.isIdle()` is also false while a compaction is running; in that window pi runs the
  alert as a new turn instead of queueing it, so "never kills work in flight" is not a perfect
  description of the compaction case.
- **Reconnects** use exponential backoff with jitter (1s → 60s), and report status in the footer.
- **No replay storms**: the stream subscribes with `since=none`, and message ids are
  de-duplicated across reconnects *and* process restarts (persisted, capped at the 500 most
  recent). A dropped connection can never replay a backlog into your context window.
- **Never breaks pi**: every handler contains its own errors; startup never blocks on the network.

## Security

> **Anyone who can publish to your topic can drive your agent.**

Treat the topic name as a capability:

- Use a **long, unguessable** topic name. Public ntfy topics are readable by anyone who knows
  the name, and messages are not end-to-end encrypted.
- Prefer a **protected topic** on a server you control, with `PI_NTFY_TOKEN` set.
- `PI_NTFY_TAG_ALLOW` is a **noise gate, not a secret.** The tag travels in the payload of the
  very topic you are subscribed to, so anyone able to read the stream learns it from the first
  tagged message and can then replay it. It filters blind publishers and unrelated traffic; it
  does not authenticate anyone. Use a protected topic + `PI_NTFY_TOKEN` for that.
- `PI_NTFY_MIN_PRIORITY` gives you a crude but effective noise gate.
- Review what your `PI_NTFY_PROMPT_TEMPLATE` asks the agent to do. This extension's whole
  purpose is to let remote input trigger agent actions — scope that deliberately.

## Limitations

- **It only works while a pi session is running.** pi-ntfy is an extension, not a daemon. If
  you need alerts handled with nobody at the keyboard, run pi in a supervised/headless way and
  keep the session alive.
- **Only messages published after the session subscribes are delivered** (`since=none`). Alerts
  that arrive while pi is down are not replayed — by design, but worth knowing.
- **Public ntfy topics are world-readable.** See Security above.
- **`/ntfy test` echoes back to itself.** The test message is published to the topic, so the
  subscription receives it and starts a turn. That is usually a feature (it proves the round trip),
  but if you don't want it, tag test messages and exclude them with `PI_NTFY_TAG_ALLOW`.
- **Long fields are truncated before injection** — body to 4000 chars, title/tags/click to
  500 each — so one huge alert cannot blow up the context window.
- Messages without an id, or non-`message` events (`open`, `keepalive`), are dropped.
- **The default state file is global, not per topic or per session.** Two pi sessions on the
  same topic share `$HOME/.pi/agent/ntfy-state.json` and the last writer wins, so their dedupe
  sets can clobber each other; switching `PI_NTFY_TOPIC` also carries the old topic's ids over.
  Harmless in practice (`since=none` is the real protection, and cross-process dedupe is not
  claimed), but set `PI_NTFY_STATE_FILE` per topic if you run several.
- `PI_NTFY_STATE_FILE=~` expands to your home **directory**, which cannot be written; the
  extension logs a warning and falls back to the default file.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run (non-watch)
npm run test:watch  # local iteration only
```

Layout:

```
src/index.ts     extension entry (default-exported factory)
src/config.ts    env parsing, defaults, validation
src/ntfy.ts      NDJSON parsing, streaming subscriber, publish helper
src/filter.ts    the delivery filter pipeline (pure)
src/template.ts  {{placeholder}} rendering (pure)
src/state.ts     persisted processed-id set
src/log.ts       stderr logger with a level gate
test/            vitest suites, no network access required
```

Releasing:

```bash
npm version patch
npm publish
```

## Related work

- **[pi-ntfy](https://www.npmjs.com/package/pi-ntfy)** by [rogeecn](https://www.npmjs.com/~rogeecn) —
  the **outbound** half: it *publishes* your pi session/task status to an ntfy topic.
- **This package** (`@4ier/pi-ntfy`) is the **inbound** half: it *subscribes* to a topic and turns
  incoming notifications into agent turns.

They are complementary and can be used together: one pokes you when a session finishes,
the other wakes an agent when your infrastructure reports a problem. Their names are similar by
design, so read the direction carefully before installing.

## License

MIT — see [LICENSE](./LICENSE).
