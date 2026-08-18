# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions are set by hand. `semantic-release` was removed in v2 — see
`docs/REWRITE-v2-PLAN.md` §9 for why.

## [Unreleased]

## [2.0.0-rc.1] - 2026-08-18

The v2 rewrite, complete. Built phase by phase against `docs/REWRITE-v2-PLAN.md`.

A release candidate rather than a stable release, and it stays one until Baileys 7
ships stable or we have run an RC in production for long enough to vouch for it.
Published under the `next` dist-tag, so `npm install @dutakey/whatsmulti` keeps
resolving to v1 until that happens.

### Added

- `spec/` — the language-neutral contract shared with the planned Go implementation
  (`whatsmulti-go`, built on whatsmeow). Session state machine, canonical disconnect
  causes, error codes, event names, config keys, REST contract, webhook envelope, and
  the shared session-metadata and lock schema.
- `spec/vectors/` — fixtures every implementation is tested against. This is the
  parity gate: a divergence between the TypeScript and Go builds becomes a red build
  in whichever repo caused it.
- `scripts/generate.mjs` — compiles `spec/*.yaml` into `src/generated/`. Enums are
  never hand-written in either runtime.
- `scripts/generate-vectors.mjs` — the reference implementation of the algorithms in
  `spec/algorithms.md`.
- Spec integrity test suite.
- Phase 1 foundation: `WhatsMultiError` with spec-driven codes, an injectable
  `Logger` interface with a zero-dependency default, validated and frozen
  configuration, a typed event bus, a plugin registry, and `src/compat/baileys.ts`
  as the single Baileys touch point.
- Phase 2 storage: a single `StorageAdapter` contract with required batch access, a
  namespaced and exactly-invertible key layout, in-memory and filesystem backends,
  and a shared conformance suite that every adapter must pass.
- Phase 3 auth: one generic auth state built on `StorageAdapter`, replacing v1's
  three near-duplicate implementations; a Buffer-preserving value codec that is
  byte-compatible with Baileys' `BufferJSON`; unambiguous Signal key naming; and lazy
  driver loading, so importing the package does not pull Baileys into the module
  graph and a missing peer reports the install command.
- Phase 4 session core: a state machine compiled from the spec, a disconnect policy
  driven by the canonical cause table, full-jitter reconnect backoff verified against
  the shared vectors, a socket factory that is also the test seam, the session itself
  (QR lifecycle, pairing codes, logout separated from local delete), and a manager
  with a namespace-derived registry, bounded loading and a real shutdown.
- Phase 5 messaging: a bounded, rate-limited per-session send queue, a send path with
  a deadline and typed failures, and a media downloader that can refresh an expired
  media URL instead of failing permanently.
- Phase 6 facade: the `WhatsMulti` client — one instance-owned config, logger, event
  bus, plugin registry and session manager — plus `@dutakey/whatsmulti/qr`, a second
  entry point that renders a QR to the terminal, SVG or PNG behind the optional
  `qrcode` peer. Baileys 7 removed `printQRInTerminal`; `qr.print` replaces it.
- Phase 7 cluster: a `LockProvider` contract whose row shape is the one in
  `spec/storage-schema.sql`, so a Go instance and a TypeScript instance sharing a
  database fence each other; an in-process provider as the default; and fail-stop
  fencing in `Session` — the lock is taken before the socket opens, renewed on a
  heartbeat, and losing it closes the socket at once and emits `session.fenced`.
- Phase 8 adapters: `@dutakey/whatsmulti/mongo`, `/redis` and `/sql`, each a storage
  backend and a lock provider on its own subpath, so installing the package never
  pulls in a database driver. The SQL one covers PostgreSQL, MySQL and SQLite through
  Drizzle. All five storage backends and all four lock providers run the shared
  conformance suites green.
- `test/conformance/lock.ts` — the lock counterpart to the storage conformance suite.
  A provider, including a third-party one, is finished when both are green.
- `LOGOUT_FAILED`, `SESSION_FAILED` and `MEDIA_DOWNLOAD_FAILED` error codes, a
  `{detail}` slot on `SEND_FAILED`, and JID/phone normalisation
  matching whatsmeow's PairPhone validation.
- Phase 9 webhook: `@dutakey/whatsmulti/webhook`, an HMAC-SHA256 signed event
  forwarder with a batching window, a bounded queue, dead-lettering and retries on the
  same full-jitter schedule as reconnects. Deliveries are posted one at a time and in
  order — parallel posts with independent retries would routinely show a receiver
  `session.state open` before the `qr` that preceded it — and a retry re-sends
  identical bytes under the original timestamp, so a receiver can verify and
  deduplicate. The envelope, the signing recipe and the verification steps are
  specified in `spec/webhook.md`.
- Phase 10 server: `@dutakey/whatsmulti/server`, a REST + SSE control plane on Hono
  behind bearer authentication, with `/healthz` and Prometheus `/metrics`. Serving
  without a token takes an explicit `insecure: true`, and passing both is refused
  rather than resolved. The HTTP status per error code lives in `spec/errors.yaml`
  rather than in the server, so an API client branching on 409 versus 422 never has to
  ask which runtime it is talking to. Contract tests validate real responses against
  `spec/openapi.yaml`.
- `spec/metrics.md` — the metric names and label rules, so a dashboard built against
  one runtime does not break on the other.
- `INVALID_REQUEST`, `UNAUTHORIZED`, `ROUTE_NOT_FOUND` and `INTERNAL_ERROR` error
  codes, and an `http` status on every code.
- `MIGRATION.md`, a rewritten README, seven runnable examples under `examples/`, and a
  typedoc API reference (`npm run docs`). The examples are type checked in CI: an
  example that no longer compiles is a documentation bug.
- CI: spec-drift gate, Node 20/22/24 matrix, a Bun job, `publint` + `attw` package
  shape validation, a typedoc validation run, and a daily job that runs the suite
  against the current Baileys release.

### Changed

- **Breaking:** ESM-only, Node >= 20. `require()` is no longer supported.
- **Breaking:** targets the Baileys `7.0.0-rc` line. v7 introduces the LID identity
  system and three new auth key types (`lid-mapping`, `device-list`, `tctoken`) that
  a v6-shaped auth state cannot persist. The v6 line is now tagged `legacy` upstream.
- Baileys is a peer dependency rather than a direct dependency, so consumers own the
  version.
- Core has **zero** runtime dependencies. `mongoose`, `pino`, `pino-pretty`, `qrcode`
  and `@hapi/boom` are gone; the storage, logging and QR backends they served become
  optional peers behind subpath exports.
- `tsc` in strict mode with `nodenext` resolution, replacing a `strict: false` build.
- Release is manual and tag-driven, with a workflow that refuses to publish when the
  git tag and `package.json` version disagree, and routes prereleases to the `next`
  dist-tag instead of `latest`.

### Fixed

- Reconnect covers every disconnect cause, with backoff and a credential purge on
  logout. v1 reconnected only on `restartRequired`, immediately and forever, and never
  purged -- so a device unlinked from the phone became an infinite reconnect loop
  against credentials that could never work again.
- Starting a session twice is refused by construction rather than by a check. v1
  needed a dedicated commit to patch that race.
- `deleteSession` no longer unlinks the device: local removal and logout are separate
  operations, and a failed unlink keeps the credentials so it can be retried.
- `qrTimeoutMs` and `maxQrAttempts` are read. v1 declared them in its types and never
  used them.
- `loadSessions` fans out with a bounded pool instead of an unbounded `Promise.all`.
- Session listing is derived from the storage namespace, replacing a filesystem scan
  whose Mongo counterpart used an async predicate inside `.filter()` and therefore
  never filtered anything.
- Sends are serialised per session. Two in flight at once mutate the same Signal
  session state concurrently, and the loser produces a message the recipient cannot
  decrypt. v1 sent straight from the caller's stack, with no queue and no rate limit.
- The send queue is bounded and refuses work when full, instead of growing until the
  process runs out of memory while the caller sees nothing wrong.
- Media downloads pass a re-upload request to the driver, so an expired media URL is
  refreshed rather than becoming a permanent failure.
- There is a shutdown path: `destroy()` stops every session and closes every adapter,
  continuing past individual failures.

- Signal keys are read and written in batches. v1 issued one storage round trip per
  key, and Baileys asks for thirty or more while resuming a session.
- Stored key names parse correctly. v1 split `<type>-<id>` with a lazy regex, so
  `pre-key-42` parsed as type `pre` with id `key-42`, and every key type except
  `session` and `tctoken` came out wrong.
- `app-state-sync-key` timestamps are revived as protobuf `Long`s rather than left as
  the numbers JSON returns, which app-state key rotation compares against.
- Resetting a corrupt Signal key store no longer removes credentials, so it no longer
  unlinks the device.

### Removed

- `semantic-release` and `release.config.cjs`.
- v1 source under `legacy/`. It was kept through the rewrite so each phase could be
  checked against what v1 actually did; `git log` holds it from here.

[unreleased]: https://github.com/0xDxTz/WhatsMulti/compare/v2.0.0-rc.1...HEAD
[2.0.0-rc.1]: https://github.com/0xDxTz/WhatsMulti/releases/tag/v2.0.0-rc.1
