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

### Removed

- `semantic-release` and `release.config.cjs`.

### Notes

- v1 source is preserved under `legacy/` for reference during the port and is removed
  in phase 11.
