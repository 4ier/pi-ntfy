# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-09-26

### Changed

- Publishing now goes through npm **Trusted Publishing (OIDC)** from GitHub Actions. No
  npm token exists anywhere: `NODE_AUTH_TOKEN` is gone from the publish workflow and the
  package is configured to require 2FA and disallow bypass-2FA tokens. Each release
  exchanges the workflow identity for a short-lived credential instead.
- This is the first release with a **provenance attestation** (0.2.0 and 0.2.1 were
  published by hand). npm generates it automatically for OIDC publishes; the verification
  is `npm view @4ier/pi-ntfy@0.2.2 dist.attestations`.

No source changes in this release — it is deliberately a metadata-only bump so the OIDC
path could be verified in isolation from the code.

## [0.2.1] - 2026-09-26

### Fixed

- Re-released as 0.2.1. The 0.2.0 version number is a permanent tombstone on the
  registry (it was published and then unpublished), so npm refuses to publish it
  again while the package itself has no downloadable versions at all. Same code as
  0.2.0.

## [0.2.0] - 2026-09-26

### Added

- **On-demand configuration.** A running session can turn alerts on without restarting pi:
  `/ntfy enable <topic>`, `/ntfy disable`, `/ntfy set <key> <value>`, `/ntfy reload`.
- **`ntfy_configure` tool** so an *agent* can configure its own alert channel. An agent cannot
  type a slash command, so without this the only way to enable alerts was for a human to set an
  environment variable and restart pi. `get` returns the effective configuration plus connection
  state; `set` writes it and applies it live.
- **Config file** `~/.pi/agent/pi-ntfy.json` (override with `PI_NTFY_CONFIG_FILE`). Keys mirror the
  environment variables; `token` accepts `$VAR` / `${VAR}` so the secret can stay in the
  environment. Written mode `0600`, atomically (temp + rename), preserving unknown keys.
- Configuration precedence is documented and enforced: **env > config file > defaults**.

### Changed

- **An unconfigured extension is now completely silent.** It used to print
  `warn PI_NTFY_TOPIC is not set; pi-ntfy is disabled` in every session and claim a footer slot.
  Not every session wants an inbound alert channel, so "no topic" is now a normal state: no
  warning, no notification, no footer entry, and no network request. The reason is available at
  debug level.
- A missing topic no longer appears in `config.errors`. Invalid values that the user explicitly
  set (a malformed topic or server URL) still do, and `NtfyConfig` gained `configured`, `source`
  and `reason` so callers can tell "not requested" apart from "requested but broken".
- `session_shutdown` clears the footer entry instead of leaving a stale `ntfy: stopped`.
- `/ntfy` with no session now prints a machine-readable configuration snapshot (token masked)
  instead of only complaining that no session is running.

### Fixed

- A malformed or unreadable config file degrades to "unconfigured" rather than breaking the
  session, and `ntfy_configure` can repair it in place.

### Testing

- 49 new tests: `test/configFile.test.ts` (path resolution, `$VAR` expansion, value mapping,
  parse/read/write including merge, unknown-key preservation, failure paths, masking) and
  integration tests for enable/disable/set/reload, the tool's get/set/no-op paths, token
  masking, and the silent-when-unconfigured regression.

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

[Unreleased]: https://github.com/4ier/pi-ntfy/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/4ier/pi-ntfy/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/4ier/pi-ntfy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/4ier/pi-ntfy/releases/tag/v0.1.0
