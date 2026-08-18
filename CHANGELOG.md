# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions are set by hand. `semantic-release` was removed in v2 — see
`docs/REWRITE-v2-PLAN.md` §9 for why.

## [Unreleased]

The v2 rewrite. Tracked phase by phase in `docs/REWRITE-v2-PLAN.md`.

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
- `LOGOUT_FAILED`, `SESSION_FAILED` and `MEDIA_DOWNLOAD_FAILED` error codes, a
  `{detail}` slot on `SEND_FAILED`, and JID/phone normalisation
  matching whatsmeow's PairPhone validation.
- CI: spec-drift gate, Node 20/22/24 matrix, a Bun job, `publint` + `attw` package
  shape validation, and a daily job that runs the suite against the current Baileys
  release.

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

### Notes

- v1 source is preserved under `legacy/` for reference during the port and is removed
  in phase 11.
