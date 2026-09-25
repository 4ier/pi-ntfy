# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-09-26

### Fixed

- **Reconnect backoff could never escalate.** It was reset as soon as the response headers
  arrived, so a server or proxy that accepted the request and closed the stream immediately
  retried at a flat ~0.5s forever (about 2 requests/second with the default unlimited retries)
  instead of backing off towards the internal 60s ceiling. The backoff is now reset only after a
  stream has stayed open for at least 30s, which is what "the endpoint is healthy" actually
  means. Covered by a regression test that fails against the old behaviour.
- **A rare silent alert loss.** The idle branch wrapped `sendUserMessage` in a `try/catch` to
  fall back to steering when the agent became busy between the `isIdle()` check and the call.
  pi's extension action never throws synchronously (it attaches its own `.catch`), so that
  branch was dead code and the message was dropped. `deliverAs` is now passed unconditionally,
  so when pi already knows it is streaming the message is *queued* instead of rejected.
  Note this narrows the window rather than closing every path: an alert that fails because no
  model is configured, or that lands in the same chunk as another alert, can still be lost —
  see the Limitations section of the README.
- **Only the message body was clamped.** A multi-megabyte `title`, tag list or `click` URL
  still reached the model. Title/tags/click are now truncated too (500 chars each).
- `PI_NTFY_STATE_FILE=~` expanded to the home *directory*, which can never be written as a
  file, and was accepted silently. It now warns and falls back to the default state file.

### Documentation

- Corrected `PI_NTFY_MAX_RETRIES` (it counts retries, not failures), the truncation claim,
  the `PI_NTFY_TAG_ALLOW` security advice (a tag is a noise gate, not a shared secret),
  the mid-turn delivery description (an alert arriving during compaction runs as a new turn),
  and added the shared/global state-file caveat.

### Fixed (follow-up pass)

- **The backoff reset was skipped whenever the stream threw.** `readStream` rejects on the
  common failure modes (RST, idle timeout, aborted socket), and the stability check lived
  inside the `try` block, so those cases jumped straight to the catch. `attempt` then only ever
  grew and a flaky link parked the reconnect delay at the 60s ceiling for the rest of the
  process' lifetime. The check now runs in the catch, before the failure is counted.

### Testing

- Every fix in this release is covered by a test that was checked to **fail** against the code
  it replaces (mutation-checked, not just written).
- Added `test/loader.test.ts`, which loads `src/index.ts` through **jiti** — the loader pi
  actually uses. Neither the unit tests (vitest's resolver) nor the CI smoke step (compiled
  JS only) covered `.js` → `.ts` specifier resolution, which is what decides whether
  `pi install` works at all. It also asserts that the `pi.extensions` path declared in
  `package.json` exists and loads, because a typo there would keep every other check green
  while making the package uninstallable.
- CI now checks `npm pack --dry-run` output, so a mistake in `files` cannot silently publish
  a tarball without the extension entry point.

## [0.1.0] - 2026-09-26

### Added

- pi extension that subscribes to an ntfy topic and injects incoming notifications as
  agent turns (idle → new turn, streaming → `steer`/`followUp`).
- Streaming NDJSON subscriber with `since=none`, exponential backoff with jitter, and
  clean abort on session shutdown.
- Delivery filter pipeline: event type → message validity → minimum priority →
  tag allowlist → de-duplication.
- Durable, capped (500) set of processed message ids so restarts cannot replay alerts.
- `{{placeholder}}` prompt templating with `{{id}}`, `{{topic}}`, `{{title}}`, `{{message}}`,
  `{{priority}}`, `{{tags}}`, `{{time}}`, `{{click}}`; bodies truncated to 4000 chars.
- `/ntfy` command with `status`, `test`, `reconnect` and `ids` subcommands.
- Full environment-variable configuration with defaults, validation and non-fatal warnings.
- Zero runtime dependencies; pi types are a devDependency only.
- Test suite (vitest, no network access) covering every pure module plus an integration
  smoke test of the extension entry point.

[Unreleased]: https://github.com/4ier/pi-ntfy/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/4ier/pi-ntfy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/4ier/pi-ntfy/releases/tag/v0.1.0
