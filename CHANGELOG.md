# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/4ier/pi-ntfy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/4ier/pi-ntfy/releases/tag/v0.1.0
