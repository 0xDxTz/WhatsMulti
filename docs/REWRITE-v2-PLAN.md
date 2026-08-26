# WhatsMulti v2 — Rewrite Plan

> Status: **Implemented.** Phases 0-11 shipped as `v2.0.0`; phase 12 (the Go
> port) is the remaining work and lives in its own repo.
> Target branch: `v2`
>
> Kept as written rather than rewritten in the past tense: the value of this document
> now is the reasoning behind each decision, which the code cannot carry. One thing it
> predates: the package ships as `whatsmulti`, not `@dutakey/whatsmulti` — the scope
> named a GitHub identity that was renamed before release.
>
> **Locked decisions**
>
> - v2 breaking release, with `MIGRATION.md`
> - ESM-only, Node >= 20
> - Storage adapters: Memory, File, MongoDB, Redis, SQL
> - Features: pairing code · reconnect policy · send queue · webhook forwarder · optional REST server · cluster-aware locking
> - **Baileys `7.0.0-rc` line** (see §3)
> - **No semantic-release.** Versioning and publishing are fully manual (see §9)
> - **A Go port (`whatsmulti-go`, built on whatsmeow) is a first-class target.** Behaviour parity is a design constraint, not an afterthought (see §4)

---

## 1. Goal

WhatsMulti is a **multi-session orchestration layer over a WhatsApp Web protocol driver** — Baileys in TypeScript, whatsmeow in Go. It is not a bot framework and not a fork of either driver. It owns exactly four responsibilities:

1. **Session lifecycle** — create/start/stop/restart/logout/delete N WhatsApp connections in one process, deterministically.
2. **Auth persistence** — pluggable storage with identical semantics across every backend.
3. **Event routing** — every driver event, plus lifecycle events, tagged with `sessionId`.
4. **Safe sending** — JID normalisation, per-session queue, backpressure.

Everything else (webhook, REST, extra adapters) lives behind subpath exports and never loads unless imported.

### Non-goals

- Wrapping every driver method. The raw socket/client stays exposed.
- Shipping a message/chat store. `getMessage` is a user-provided hook.
- Being a CLI or a hosted service.
- **Binary-compatible auth storage between TS and Go.** See §4.2 — this is impossible and pretending otherwise would be a trap.

---

## 2. Packaging strategy

**One package, many subpaths.** A monorepo was considered and rejected: it multiplies release plumbing for code that shares one version anyway. ESM + `sideEffects: false` means an unimported subpath costs nothing at runtime.

```
@dutakey/whatsmulti            core — sessions, auth, events, messaging   (0 runtime deps)
@dutakey/whatsmulti/mongo      MongoDB storage + lock   (peer: mongodb)
@dutakey/whatsmulti/redis      Redis storage + lock     (peer: ioredis)
@dutakey/whatsmulti/sql        SQL storage + lock       (peer: drizzle-orm + a driver)
@dutakey/whatsmulti/webhook    HTTP event forwarder     (no deps, uses global fetch)
@dutakey/whatsmulti/server     REST + SSE control plane (peer: hono)
@dutakey/whatsmulti/qr         QR render helpers        (peer: qrcode)
```

### Dependency policy

| Kind                            | Packages                                                      | Rationale                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dependencies`                  | **none**                                                      | Core must install clean and run anywhere.                                                                                                              |
| `peerDependencies`              | `@whiskeysockets/baileys` `>=7.0.0-rc14 <8`                   | Baileys ships breaking changes often and users routinely pin or fork it. Letting the consumer own the version is the single biggest compatibility win. |
| `peerDependenciesMeta.optional` | `mongodb`, `ioredis`, `drizzle-orm`, `hono`, `qrcode`, `pino` | Only needed by the matching subpath. Missing peer produces a typed `MissingPeerError` naming the exact install command.                                |

Dropped from v1: `mongoose` (heavy ODM for a key-value use case — replaced by the raw `mongodb` driver), `pino` + `pino-pretty` (replaced by an injectable logger interface with a ~30 LOC console default), `qrcode` (moved to optional), `@hapi/boom` (only used for a type cast — replaced by defensive status-code reading), `semantic-release` (see §9).

### Build

`tsc` only. No bundler.

- `"type": "module"`, `module: "nodenext"`, `moduleResolution: "nodenext"`, explicit `.js` extensions in source imports.
- Per-file output → maximum tree-shaking, readable stack traces, zero build-tool dependency.
- `exports` map with `types` first per condition; `sideEffects: false`; `engines.node: ">=20"`.
- CI validates the published shape with `publint` and `@arethetypeswrong/cli` — this is what catches subpath/types mistakes before users do.

### TypeScript

`strict: true` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`. v1 ran `strict: false`, which is how `error.message` on an `unknown` and several implicit `any` shipped.

---

## 3. Baileys version: v7 RC, not v6

**Decision: target the `7.0.0-rc` line.** Verified against the npm registry on 2026-08-18:

```
dist-tags: { latest: "7.0.0-rc14", legacy: "6.7.24" }
```

The maintainers already point every new install at v7 and have re-tagged the entire v6 line as `legacy`. Three reasons this is not a close call:

1. **LID is mandatory, and it is an auth-state change.** v7 implements WhatsApp's Local Identifier system, which replaces phone numbers as the Signal identity. The migration guide states the auth state must now persist three new `SignalDataTypeMap` key types — **`lid-mapping`, `device-list`, `tctoken`** — and exposes `sock.signalRepository.lidMapping` (`storeLIDPNMapping`, `getLIDForPN`, `getPNForLID`, …). A v6-shaped auth state has no slot for these. As WhatsApp completes the LID rollout, a v6 store silently loses identity mappings and sessions break in ways that look like random decryption failures. Our storage layer is the _whole point_ of this library, so building it against the pre-LID key set would be building it obsolete.

2. **whatsmeow is already LID-aware.** Its `sqlstore.Container` carries a `LIDMap *CachedLIDMap` field. Choosing Baileys v6 would mean the TS and Go builds disagree about user identity — precisely the divergence this rewrite exists to prevent.

3. **v6 is a dead end for new work.** `legacy` is a maintenance tag. Anything we build on it we rebuild in six months.

### RC risk management

An RC can break between RCs. Mitigations, all cheap:

- Peer range `>=7.0.0-rc14 <8`; **exact** RC pinned in `devDependencies` so CI is reproducible.
- **`src/compat/baileys.ts`** — every Baileys touch point funnels through one module: socket construction, the `SignalDataTypeMap` key list, disconnect status-code reading, and the `downloadMediaMessage` signature (v7 added a 4th `ctx` parameter). An RC bump becomes a one-file diff plus a test run, not a codebase sweep.
- A scheduled CI job installs `@whiskeysockets/baileys@latest` daily and runs the full suite. Drift surfaces as a red build within a day, not as a user bug report.
- Ship v2.0.0 only once we are on a stable `7.x` or an RC we have run in production; until then release under the `next` dist-tag (§9).

### v7 details already folded into the design

- `qrTimeout` in `SocketConfig` is what v1's never-implemented `qrMaxWaitMs` was reaching for — §6.2 wires it.
- `printQRInTerminal` is gone from v7's `SocketConfig`. Our `printQR` option is implemented in our own layer via the optional `qrcode` peer, so it is unaffected.
- New auth key types are handled generically: our adapters store opaque encoded values keyed by `type-id`, so `lid-mapping`/`device-list`/`tctoken` need **zero** adapter changes. This is a direct payoff of §5.1's design.

---

## 4. Cross-runtime parity (TypeScript + Go)

A Go port on whatsmeow is planned. Parity is enforced by artefacts, not by good intentions — documentation drifts, test vectors do not.

### 4.1 What "same behaviour" means

The two drivers are structurally different: Baileys is one `makeWASocket` per session with a pluggable auth state; whatsmeow is a `sqlstore.Container` holding many `store.Device`s, one `Client` per device. Forcing one runtime to imitate the other's idioms produces bad code in whichever one loses. So parity is defined per layer:

| Layer                            | Parity requirement                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| Session state machine            | **Identical.** Same states, same legal transitions, same names.                       |
| Disconnect cause → action        | **Identical.** One shared mapping table (§4.3).                                       |
| Reconnect backoff                | **Identical.** Same formula, same defaults, verified against shared vectors.          |
| Error codes                      | **Identical** string enum.                                                            |
| Config keys                      | **Identical** in files/env (`snake_case`); idiomatic in code.                         |
| Lifecycle event names & payloads | **Identical on the wire** (REST/SSE/webhook).                                         |
| Driver-native events in-process  | **Idiomatic per language.** TS keeps `messages.upsert`; Go keeps `*events.Message`.   |
| REST API                         | **Identical.** One OpenAPI document, two implementations.                             |
| Webhook envelope + HMAC          | **Identical**, byte for byte.                                                         |
| Session-metadata & lock schema   | **Identical**, so a TS and a Go instance can share one database and fence each other. |
| Signal/auth binary storage       | **Not shared.** See §4.2.                                                             |
| Public API shape                 | Same operations, same names where the language allows; idiomatic signatures.          |

### 4.2 The one honest limitation

whatsmeow owns its device store schema (`sqlstore`) and Baileys owns its `AuthenticationCreds` shape. **A session paired under the TS build cannot be resumed by the Go build, or vice versa.** Migrating a live session between runtimes means re-pairing.

This is stated up front in the README of both repos. The alternative — reimplementing whatsmeow's store in TS or Baileys' creds in Go — is a large, permanently-drifting surface for a use case almost nobody has.

What _is_ shared: the session registry, session metadata (storage type, socket config, state, timestamps), and the distributed lock table. That is what makes a mixed-runtime cluster work, and it is enough.

### 4.3 Canonical disconnect causes

The crux of behavioural parity. Both drivers report disconnects differently — Baileys via `DisconnectReason` status codes on a `Boom`, whatsmeow via typed events plus `ConnectFailureReason` codes. Both map into one canonical enum, and the enum maps to exactly one action.

| Canonical cause        | Baileys (`DisconnectReason` / status) | whatsmeow                                               | Action                           |
| ---------------------- | ------------------------------------- | ------------------------------------------------------- | -------------------------------- |
| `restart_required`     | `restartRequired` (515)               | internal restart path                                   | reconnect immediately            |
| `connection_closed`    | `connectionClosed` (428)              | `events.Disconnected`                                   | reconnect with backoff           |
| `connection_lost`      | `connectionLost`                      | `events.Disconnected`                                   | reconnect with backoff           |
| `timed_out`            | `timedOut` (408)                      | `events.KeepAliveTimeout`                               | reconnect with backoff           |
| `service_unavailable`  | `unavailableService`                  | `ConnectFailureServiceUnavailable` (503)                | reconnect with backoff           |
| `server_error`         | 500 non-`badSession`                  | `ConnectFailureInternalServerError` (500)               | reconnect with backoff           |
| `connection_replaced`  | `connectionReplaced` (440)            | `events.StreamReplaced`                                 | **terminal**                     |
| `logged_out`           | `loggedOut` (401)                     | `events.LoggedOut`, `ConnectFailureLoggedOut` (401)     | **terminal**, purge creds        |
| `bad_session`          | `badSession` (500)                    | —                                                       | **terminal**, purge creds        |
| `multidevice_mismatch` | `multideviceMismatch` (411)           | `events.QRScannedWithoutMultidevice`                    | **terminal**                     |
| `device_removed`       | `forbidden` (403)                     | `ConnectFailureMainDeviceGone` (403)                    | **terminal**, purge creds        |
| `banned`               | —                                     | `ConnectFailureUnknownLogout` (406)                     | **terminal**, purge creds        |
| `temporary_ban`        | —                                     | `events.TemporaryBan`, `ConnectFailureTempBanned` (402) | **terminal**, surface expiry     |
| `client_outdated`      | —                                     | `ConnectFailureClientOutdated` (405)                    | **terminal**, needs version bump |
| `bad_user_agent`       | —                                     | `ConnectFailureBadUserAgent` (409)                      | **terminal**                     |
| `unknown`              | anything else                         | anything else                                           | reconnect with backoff, capped   |

Causes with no counterpart in one driver still exist in both enums — the Go build can emit `temporary_ban`, the TS build simply never produces it today. Consumers write one switch that works against either runtime, and a future Baileys release can start populating the gap without an API change.

**whatsmeow's built-in auto-reconnect is switched off** (`EnableAutoReconnect = false`) in the Go port. Reconnection is owned by our policy in both runtimes, or the two would diverge on timing immediately.

### 4.4 The `spec/` directory — single source of truth

Lives in this repo; the Go repo consumes it as a git submodule.

```
spec/
  VERSION                    # spec version, semver, independent of package versions
  states.yaml                # session states + legal transitions
  disconnect-causes.yaml     # §4.3 table, machine-readable
  errors.yaml                # error code enum + messages
  events.yaml                # canonical lifecycle event names + payload schemas
  config.yaml                # canonical config keys, types, defaults
  openapi.yaml               # REST control plane
  webhook.md                 # envelope + signature algorithm
  storage-schema.sql         # shared session-metadata + lock tables
  vectors/
    backoff.json             # seeded attempt -> delay sequences
    disconnect-mapping.json  # driver code -> canonical cause
    jid.json                 # input -> normalised JID
    webhook-signature.json   # payload + secret -> expected signature
    storage-keys.json        # (session, key) -> namespaced key
```

Both repos run the **same** `vectors/` fixtures in their own test suites. A divergence is a red build, in the repo that caused it, the day it lands. This is the entire parity mechanism; the prose exists to explain it, not to enforce it.

Code generation, where it pays: `states.yaml`, `errors.yaml`, and `disconnect-causes.yaml` generate a TS module and a Go file. Hand-writing an enum twice is how the two drift.

### 4.5 Feature matrix

Every row must land in both runtimes before the corresponding feature is declared stable.

| Feature                 | TS                      | Go                   | Notes                                                |
| ----------------------- | ----------------------- | -------------------- | ---------------------------------------------------- |
| Multi-session lifecycle | ✅ core                 | ✅ core              | identical state machine                              |
| Storage: memory         | ✅                      | ✅                   |                                                      |
| Storage: file           | ✅                      | ✅                   | different on-disk format, same semantics             |
| Storage: SQL            | ✅ drizzle              | ✅ native `sqlstore` | shared metadata + lock schema                        |
| Storage: Mongo          | ✅                      | ✅                   | Go stores Signal data as blobs                       |
| Storage: Redis          | ✅                      | ✅                   |                                                      |
| QR login                | ✅                      | ✅                   | same `qr` event shape, same attempt/expiry semantics |
| Pairing code            | ✅ `requestPairingCode` | ✅ `PairPhone`       | same validation, same `XXXX-XXXX` format             |
| Reconnect policy        | ✅                      | ✅                   | driver auto-reconnect disabled in Go                 |
| Send queue              | ✅                      | ✅                   | same ordering + rate-limit guarantees                |
| Cluster locking         | ✅                      | ✅                   | interoperable — same lock table                      |
| Webhook forwarder       | ✅                      | ✅                   | identical envelope + HMAC                            |
| REST server             | ✅ hono                 | ✅ net/http          | one OpenAPI document                                 |
| Plugin system           | ✅                      | ✅                   | idiomatic: TS object, Go interface                   |

Pairing-code parity has one real trap worth pre-empting: whatsmeow's `PairPhone` requires the client to be connected and to have seen the first QR event first, rejects numbers of 6 digits or fewer and numbers starting with `0`, and silently overwrites any pending pairing attempt on a repeat call. Our layer enforces those preconditions **and** the no-concurrent-pairing guard in _both_ runtimes, so the TS build cannot accept input the Go build would reject.

QR timing likewise: whatsmeow emits a fixed ladder (20s per code, 60s for the last, ~160s total, then the socket closes), while Baileys regenerates on `qrTimeout`. Our layer normalises both to `{ qr, attempt, expiresAt }` with a shared `maxQrAttempts` / `qrTimeoutMs` budget.

---

## 5. Architecture

### 5.1 Layer map

```
                 ┌────────────────────────────────────┐
   public API →  │  WhatsMulti (facade)               │
                 │  config · plugins · events         │
                 └───────────────┬────────────────────┘
                                 │
                 ┌───────────────▼────────────────────┐
                 │  SessionManager                    │
                 │  registry · concurrency · shutdown │
                 └───────────────┬────────────────────┘
                                 │  owns N ×
                 ┌───────────────▼────────────────────┐
                 │  Session                           │
                 │  state machine · reconnect · queue │
                 └───┬───────────────────────┬────────┘
                     │                       │
        ┌────────────▼─────────┐   ┌─────────▼──────────┐
        │  AuthState (generic) │   │  compat/baileys    │
        └────────────┬─────────┘   └────────────────────┘
                     │
        ┌────────────▼──────────────────────────────────┐
        │  StorageAdapter  (memory│file│mongo│redis│sql) │
        │  + LockProvider                               │
        └───────────────────────────────────────────────┘
```

Dependencies point **downward only**. `storage/` never imports `session/`. Enforced by an ESLint `no-restricted-imports` rule per directory, so the layering cannot rot.

### 5.2 File tree

```
spec/                         # §4.4 — source of truth, shared with the Go repo

src/
  index.ts                  # public surface, nothing else
  client.ts                 # WhatsMulti facade
  config.ts                 # defaults + resolve + validate
  errors.ts                 # generated from spec/errors.yaml
  logger.ts                 # Logger interface + console default
  plugin.ts                 # Plugin contract + registry

  compat/
    baileys.ts              # sole Baileys touch point — see §3

  events/
    emitter.ts              # typed emitter, never throws into user land
    types.ts                # EventMap = BaileysEventMap & lifecycle events

  session/
    session.ts              # a single session; owns one socket
    manager.ts              # registry, bounded concurrency, graceful shutdown
    state.ts                # generated from spec/states.yaml
    disconnect.ts           # generated from spec/disconnect-causes.yaml
    reconnect.ts            # backoff policy
    socket-factory.ts       # assembles makeWASocket config
    lock.ts                 # LockProvider interface + memory impl

  auth/
    auth-state.ts           # StorageAdapter -> AuthenticationState (one impl, all backends)
    codec.ts                # BufferJSON encode/decode, centralised
    keys.ts                 # STORAGE_KEYS (carried over from src/Storage/StorageKeys.ts)

  storage/
    adapter.ts              # StorageAdapter interface
    memory.ts
    file.ts
    namespace.ts            # key prefixing + escaping
    resolve.ts              # 'memory'|'file'|AdapterInstance -> adapter

  messaging/
    send.ts
    queue.ts                # per-session serial queue, rate limit
    jid.ts                  # normalise / classify
    media.ts                # download helper

  types/                    # public type re-exports only
  utils/                    # backoff, defer, limit, assert — each < 40 LOC

adapters/mongo/  adapters/redis/  adapters/sql/
plugins/webhook/  plugins/server/  plugins/qr/

test/
  unit/
  conformance/storage.ts    # one suite, run against every adapter
  vectors/                  # runs spec/vectors/*.json
  fixtures/fake-socket.ts   # Baileys stand-in, no network
```

Rule: no directory exists to hold a single file. If a concern is under ~40 LOC it lives in `utils/`.

---

## 6. Core contracts

### 6.1 StorageAdapter

The keystone. One interface replaces v1's three near-duplicate auth-state files (~200 LOC → ~60).

```ts
export interface StorageAdapter {
    readonly name: string;
    init?(): Promise<void>;
    get<T>(key: string): Promise<T | null>;
    mget<T>(keys: string[]): Promise<(T | null)[]>; // required: Baileys reads keys in batches
    set(key: string, value: unknown): Promise<void>;
    mset(entries: Array<[string, unknown]>): Promise<void>;
    del(keys: string[]): Promise<void>;
    keys(prefix: string): Promise<string[]>;
    clear(prefix: string): Promise<void>;
    close?(): Promise<void>;
}
```

- **`mget`/`mset` are mandatory.** v1 issued one round-trip per Signal key; Baileys asks for 30+ at once during a session resume. Batch turns that into a single query.
- Values are **opaque** to the adapter — encoding happens in `auth/codec.ts`. This is why v7's new `lid-mapping` / `device-list` / `tctoken` key types need no adapter change at all (§3).
- Every key is namespaced `whatsmulti:<sessionId>:<key>` via `storage/namespace.ts`, so _one collection/table/keyspace holds all sessions_. v1 created one Mongo collection **and one global Mongoose model** per session id — a guaranteed name collision and memory leak at scale.
- `keys(prefix)` replaces filesystem scanning, which fixes v1's broken `getAllExistingSessions` (its `checkSessionExistOnMongo` was `async` but used inside `.filter()`, so the predicate was always a truthy Promise and nothing was ever filtered).

**Conformance suite.** `test/conformance/storage.ts` exports one parametrised suite asserting the full contract, including Buffer round-trip fidelity and prefix isolation. Every adapter — including third-party ones — runs it. A new adapter is "done" when the suite is green.

### 6.2 LockProvider (cluster-aware, cross-runtime)

```ts
export interface LockProvider {
    acquire(key: string, ttlMs: number): Promise<LockToken | null>;
    renew(token: LockToken, ttlMs: number): Promise<boolean>;
    release(token: LockToken): Promise<void>;
}
```

- `Session.start()` must hold `lock:session:<id>` before opening a socket. No lock → `SESSION_LOCKED` error naming the owning instance.
- Heartbeat renews at `ttl / 3`. A failed renew means another process fenced us: stop the socket immediately and emit `session.fenced`. Fail-stop, never split-brain — two processes on one session corrupts the Signal key store.
- Memory provider (default, single-process) ships in core. Redis = `SET NX PX` + Lua-guarded release. Mongo = `findOneAndUpdate` with a TTL index. SQL = advisory lock / conditional row update.
- Each client gets an `instanceId` (`hostname:pid:rand`) recorded in the lock value and surfaced in logs. The value format is specified in `spec/storage-schema.sql`, so **a Go instance and a TS instance fence each other correctly**.

### 6.3 Session state machine

```
        create
          │
          ▼
  ┌───► idle ──start──► connecting ──qr──► awaiting_scan ──┐
  │      ▲                  │                              │
  │      │                  └──────────── open ◄───────────┘
  │      │                                 │
  │   closed ◄── closing ◄── stop ─────────┘
  │      │
  │      └── reconnect(backoff) ──► connecting
  │
  └── logged_out (terminal) ── requires re-auth
```

Generated from `spec/states.yaml` in both runtimes. Illegal transitions throw instead of silently corrupting state. v1 had no machine — it tracked a bare `status` string and needed a dedicated commit (`d95ef51 fix(session): prevent duplicate session start attempts`) to patch a race the machine makes structurally impossible.

Every transition emits `session.state` with `{ from, to, reason }`.

### 6.4 Reconnect policy

Driven by the canonical cause table in §4.3. Backoff: exponential with full jitter, `base 1s`, `cap 60s`, `maxAttempts` configurable (`Infinity` allowed), attempt counter resets on a successful `open`. Emits `session.reconnecting` with `{ attempt, delayMs, cause }`.

Both runtimes are verified against `spec/vectors/backoff.json` — a seeded RNG makes jittered delays deterministic and therefore testable across languages.

v1 handled exactly one case (`restartRequired`), with no backoff and no credential purge on `loggedOut`.

### 6.5 Events

```ts
export type EventMap = BaileysEventMap & {
    qr: { qr: string; attempt: number; expiresAt: number };
    'pairing.code': { code: string; phoneNumber: string };
    'session.state': { from: SessionState; to: SessionState; reason?: string };
    'session.created': { storage: string };
    'session.removed': { reason: 'deleted' | 'logged_out' };
    'session.reconnecting': { attempt: number; delayMs: number; cause: DisconnectCause };
    'session.logged_out': { cause: DisconnectCause };
    'session.fenced': { owner: string };
    'session.error': { error: WhatsMultiError };
};
```

The lifecycle half of this map is generated from `spec/events.yaml` and is identical in Go. The `BaileysEventMap` half is TS-only by design (§4.1).

Kept from v1 (good DX, do not change): `on(event, (data, { sessionId, socket }) => …)` and the `process()` catch-all.

Fixed in v2:

- **`process()` receives the real Baileys batch.** v1 re-split `ev.process`'s buffered map into one call per event, destroying the batching Baileys works hard to provide. v2 passes the batch through intact to `process()` while still fanning out to `on()`.
- **A throwing listener cannot kill the process.** Listeners are invoked inside a guard; a rejection is routed to `session.error`. v1 let an async listener rejection become an unhandled rejection.
- No `'error'` event name — Node's `EventEmitter` throws when `'error'` has no listener. Lifecycle errors use `session.error`.

### 6.6 Errors

Generated from `spec/errors.yaml`; the same codes exist in Go.

```ts
export class WhatsMultiError extends Error {
    readonly code: ErrorCode;
    readonly sessionId?: string;
    readonly cause?: unknown;
}

export type ErrorCode =
    | 'SESSION_NOT_FOUND'
    | 'SESSION_EXISTS'
    | 'INVALID_SESSION_ID'
    | 'SESSION_NOT_READY'
    | 'SESSION_LOCKED'
    | 'SESSION_LOGGED_OUT'
    | 'STORAGE_ERROR'
    | 'SEND_FAILED'
    | 'TIMEOUT'
    | 'MISSING_PEER'
    | 'INVALID_CONFIG'
    | 'CLIENT_DESTROYED'
    | 'PAIRING_UNAVAILABLE'
    | 'INVALID_PHONE_NUMBER';
```

v1 threw bare `new Error('Session exists')`, forcing consumers to string-match — its own README documents that anti-pattern. Codes are part of the public API and covered by tests.

### 6.7 Plugin contract

```ts
export interface Plugin {
    readonly name: string;
    setup(ctx: PluginContext): void | Promise<void>;
    dispose?(): Promise<void>;
}
client.use(webhook({ url, secret }));
```

~40 LOC. This is what keeps webhook/server/metrics _out_ of core while still making them first-class. `dispose()` participates in `client.destroy()`. Go equivalent is an interface with the same two methods.

### 6.8 No global singletons

v1 kept a module-level `sessions` Map and a module-level `Configs`, so two `WhatsMulti` instances silently shared state — and the module-level `logger` read `Configs.getValue('LoggerLevel')` at import time, before any config was ever set, so the log-level option never worked. In v2 every one of these is instance-owned and injected.

---

## 7. Feature specs

### 7.1 Pairing code login

```ts
const code = await client.requestPairingCode(sessionId, '628123456789');
```

Preconditions enforced identically in both runtimes (§4.5): session connected, first QR seen, phone number digits-only, longer than 6 digits, not starting with `0`, and no pairing attempt already pending for that session. Emits `pairing.code`, and suppresses QR emission for that session when `loginMethod: 'pairing'`. Returns the `XXXX-XXXX` formatted code.

### 7.2 QR lifecycle

Emits the raw `qr` string always — rendering is optional and lazy. `@dutakey/whatsmulti/qr` provides `toDataURL()` / `toTerminal()` behind the optional `qrcode` peer.

Finally implements the options v1 declared in its types but never read: `qrTimeoutMs` (maps to Baileys v7 `qrTimeout`; the Go build derives it from whatsmeow's QR ladder), `maxQrAttempts`, `printQR`.

### 7.3 Send queue

Per-session FIFO with configurable `concurrency` (default 1) and `minDelayMs` between sends (default 0). Serialising sends prevents interleaved Signal session updates and gives one place to add rate limiting. Exposes `queueSize` for backpressure and drains on `stop()`.

### 7.4 Webhook forwarder

`@dutakey/whatsmulti/webhook`, zero dependencies (global `fetch`).

- Event allow-list, optional batching window.
- `POST` with `x-whatsmulti-signature: t=<unix>,v1=<hmac-sha256>` over `<t>.<body>` — timestamped to make replay detectable. Signed with `node:crypto`.
- Delivery queue with exponential backoff, bounded in-memory buffer, `onDeadLetter` callback for overflow/permanent failure.
- Envelope and signature algorithm live in `spec/webhook.md`; both runtimes are tested against `spec/vectors/webhook-signature.json`. A receiver cannot tell which runtime sent the request.

### 7.5 REST control plane

`@dutakey/whatsmulti/server`, Hono as optional peer — it runs on Node, Bun, Deno, and edge. The Go build implements the same routes on `net/http`.

```
GET    /sessions                  list + status
POST   /sessions                  create (+ optional autoStart)
GET    /sessions/:id              detail
DELETE /sessions/:id              delete
POST   /sessions/:id/start|stop|restart|logout
GET    /sessions/:id/qr           ?format=json|png
POST   /sessions/:id/pairing-code
POST   /sessions/:id/messages     send
GET    /events                    SSE stream (filterable by session)
GET    /healthz  GET /metrics     liveness + Prometheus text
```

`spec/openapi.yaml` is the contract; both servers are contract-tested against it, so an API client works unchanged against either runtime. Bearer-token auth, required by default — the server refuses to boot with auth disabled unless `insecure: true` is passed explicitly.

---

## 8. Public API sketch

```ts
import { WhatsMulti, fileStorage } from '@dutakey/whatsmulti';
import { mongoStorage } from '@dutakey/whatsmulti/mongo';

const client = new WhatsMulti({
  storage: fileStorage({ path: './sessions' }),   // default storage for new sessions
  logger,                                          // any pino-compatible logger
  reconnect: { maxAttempts: Infinity, capMs: 60_000 },
  send:      { concurrency: 1, minDelayMs: 250 },
  socket:    { browser: ['WhatsMulti', 'Chrome', '2.0.0'] },
});

await client.createSession('a');                                   // default storage
await client.createSession('b', { storage: mongoStorage({ db }) }); // per-session override
await client.start('a');

client.on('qr',   (d, { sessionId }) => …);
client.on('open', (_, { sessionId }) => …);
client.on('messages.upsert', (d, { sessionId, socket }) => …);

await client.send('a', '628123@s.whatsapp.net', { text: 'hi' });
await client.destroy();   // stop every socket, flush creds, close adapters
```

Notable v1 → v2 changes: `connectionType` string → a `StorageAdapter` instance (`'memory'` / `'file'` still accepted as shorthand); `startSession`/`stopSession`/… → `start`/`stop`/…; `sendMessage` → `send`; new `destroy()`; every error is a `WhatsMultiError`.

---

## 9. Versioning & release — manual, no semantic-release

**`semantic-release` is removed**, along with `release.config.cjs` and its step in the release workflow. Version numbers become an explicit decision, not a side effect of commit-message grammar.

Rationale beyond "too strict": we now ship **two** packages in **two** ecosystems. Go modules are versioned by git tag and have no equivalent tool — `v2.0.0` is a tag someone pushes on purpose. Keeping semantic-release on the TS side would mean two different release philosophies for one product, with npm versions drifting out of step with Go tags. Manual tagging makes both repos release in lockstep by construction.

### Process

1. Land changes on `v2` / `main`.
2. Edit `version` in `package.json` by hand.
3. Write the `CHANGELOG.md` entry by hand — [Keep a Changelog](https://keepachangelog.com) format.
4. Commit, then `git tag v2.0.0 && git push --tags`.
5. The tag push triggers `release.yml`.

### `release.yml` guards

- **Tag/version match**: the workflow fails if the git tag does not equal `package.json`'s `version`. This is the single check that makes manual versioning safe.
- **Full gate before publish**: lint → typecheck → test → build → `publint` → `attw --pack`. v1's release workflow ran no tests at all and was pinned to the long-deprecated `actions/checkout@v2`.
- **Prerelease routing**: a version containing `-` publishes with `--tag next`; only clean semver publishes to `latest`. This is exactly the mistake that would otherwise bite us while we track Baileys RCs (§3).
- `npm publish --provenance`, and a GitHub Release created from the changelog entry.
- `workflow_dispatch` with a dry-run input, for rehearsing a release.

### Conventions kept

Conventional Commits stay as a _convention_ — useful for drafting the changelog and skimming history — but nothing automated depends on them any more.

The Go repo mirrors this: hand-written `CHANGELOG.md`, `git tag v2.0.0`, CI verifies the tag matches the spec version it claims to implement.

---

## 10. Testing

`vitest` (native ESM, fast watch).

| Target             | Approach                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Spec vectors       | every file in `spec/vectors/` runs as a test — the parity gate (§4.4)                       |
| Storage adapters   | shared conformance suite; Mongo/Redis/SQL via testcontainers, skipped when Docker is absent |
| Auth codec         | property test: arbitrary Buffers survive encode→decode byte-identical                       |
| v7 key types       | `lid-mapping`, `device-list`, `tctoken` round-trip through every adapter                    |
| State machine      | exhaustive legal/illegal transition table, generated from the spec                          |
| Disconnect mapping | every Baileys code → expected canonical cause → expected action                             |
| Reconnect policy   | seeded backoff sequence matches `spec/vectors/backoff.json` bit for bit                     |
| Session lifecycle  | `fixtures/fake-socket.ts` — a Baileys stand-in emitting scripted events, no network         |
| Send queue         | ordering, concurrency cap, min-delay, drain on stop                                         |
| Locking            | two clients over one memory/redis lock; fencing path asserted                               |
| Events             | batch integrity in `process()`, listener isolation, error routing                           |
| Webhook            | signature vectors, retry schedule, dead-letter                                              |
| REST               | contract tests against `spec/openapi.yaml`                                                  |
| Public API         | type-level tests via `expectTypeOf`                                                         |

Gate: **80% line coverage on `src/`, 100% on `session/state.ts`, `session/disconnect.ts`, and `session/reconnect.ts`.** v1 has zero tests.

---

## 11. CI/CD

`.github/workflows/ci.yml` — on PR and push:

1. `lint` → `typecheck` → `test` (matrix: Node 20 / 22 / 24, plus one Bun job)
2. `build` → `publint` → `attw --pack`
3. coverage upload, threshold enforced
4. **spec check**: fail if `spec/` changed without a `spec/VERSION` bump

`.github/workflows/baileys-drift.yml` — daily: install `@whiskeysockets/baileys@latest`, run the suite, open an issue on failure (§3).

`.github/workflows/release.yml` — on tag push, per §9.

---

## 12. Delivery phases

Each phase ends green (lint + typecheck + tests) and is one reviewable commit range.

| #   | Phase        | Deliverable                                                                           | Gate                                        |
| --- | ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| 0   | Scaffold     | branch `v2`, ESM tsconfig, eslint layering rule, vitest, CI, semantic-release removed | CI green on empty suite                     |
| 0.5 | **Spec**     | `spec/` §4.4 — states, causes, errors, events, config, vectors + generators           | generated code compiles; vector tests run   |
| 1   | Foundation   | `errors` · `logger` · `config` · `events` · `plugin` · `compat/baileys`               | unit tests                                  |
| 2   | Storage      | `adapter` · `namespace` · `memory` · `file` · conformance suite                       | conformance green ×2                        |
| 3   | Auth         | `codec` · `keys` · generic `auth-state` (incl. v7 LID key types)                      | Buffer round-trip property test             |
| 4   | Session core | `state` · `disconnect` · `reconnect` · `socket-factory` · `session` · `manager`       | fake-socket lifecycle + all mapping vectors |
| 5   | Messaging    | `jid` · `queue` · `send` · `media`                                                    | ordering + rate-limit + JID vectors         |
| 6   | Facade       | `client` · `index` · public types · pairing code · QR                                 | type tests + end-to-end fake-socket run     |
| 7   | Cluster      | `LockProvider` + memory impl, fencing in `Session`                                    | two-client contention test                  |
| 8   | Adapters     | `mongo` · `redis` · `sql` (+ their lock impls)                                        | conformance green ×5                        |
| 9   | Webhook      | plugin + signing + retry                                                              | signature vectors                           |
| 10  | Server       | Hono app, auth, SSE, metrics                                                          | OpenAPI contract tests                      |
| 11  | Release      | README, `MIGRATION.md`, `CHANGELOG.md`, examples, typedoc                             | `v2.0.0` published under `latest`           |
| 12  | **Go port**  | `whatsmulti-go` consuming `spec/` as a submodule                                      | same vector suite green in Go               |

Phases 0–6 are the shippable core; 7–11 are additive and can each ship as a minor. Phase 0.5 is deliberately early — writing the spec before the code is what makes the Go port a port rather than a rewrite.

---

## 13. v1 defects this rewrite closes

| #   | v1 defect                                                                                                                               | Closed by                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | `strict: false`; `error.message` on `unknown`; implicit `any`                                                                           | §2 TypeScript                                       |
| 2   | Zero tests, release workflow never runs them                                                                                            | §10, §11                                            |
| 3   | `localConnectionPath` config ignored by `authState` and `checkSessionExistOnLocal` — reads and deletes used different paths             | §6.1 namespacing, config injected not module-global |
| 4   | `checkSessionExistOnMongo` is `async` inside `.filter()` → predicate always truthy, filter is a no-op                                   | §6.1 `keys(prefix)`                                 |
| 5   | `mongoose.model(sessionId, …)` per session → global model registry collision + leak; one collection per session                         | §6.1 single namespaced collection, raw driver       |
| 6   | Module-global `sessions` Map and `Configs` → two clients share state                                                                    | §6.8                                                |
| 7   | Logger built at import time, before config is set → `LoggerLevel` never applied                                                         | §6.8                                                |
| 8   | Errors are bare strings, matched by message text                                                                                        | §6.6                                                |
| 9   | Only `restartRequired` reconnects; no backoff, no `loggedOut` purge                                                                     | §4.3, §6.4                                          |
| 10  | `disableQRRetry`, `qrMaxWaitMs`, `defaultConnectionType`, `scanned` declared in types but never read                                    | §7.2, config validation                             |
| 11  | `loadSessions()` fans out unbounded `Promise.all`                                                                                       | §5 `SessionManager` bounded concurrency             |
| 12  | No `destroy()` / graceful shutdown → leaks in tests and serverless                                                                      | §8                                                  |
| 13  | `process()` destroys Baileys' event batching                                                                                            | §6.5                                                |
| 14  | Async listener rejection becomes an unhandled rejection                                                                                 | §6.5                                                |
| 15  | Signal keys fetched one round-trip at a time                                                                                            | §6.1 `mget`                                         |
| 16  | Heavy deps (`mongoose`, `pino-pretty`) forced on every consumer                                                                         | §2                                                  |
| 17  | `delete` and `logout` conflated — `deleteSession` calls `logout()`, unlinking the device even when the caller only wanted local cleanup | §8 explicit separation                              |
| 18  | Pinned to the pre-LID Baileys v6 line, now tagged `legacy`                                                                              | §3                                                  |
| 19  | Release version controlled by commit-message parsing, not by a person                                                                   | §9                                                  |

---

## 14. Open items

- **Baileys as a peer dependency** widens compatibility with forks but makes install two steps. Flagged in README quick-start.
- **SQL adapter engine**: Drizzle over Prisma — no code generation step, far smaller install, and one adapter covers pg/mysql/sqlite. It also has to match the schema whatsmeow's `sqlstore` uses for our shared metadata/lock tables, so schema ownership sits in `spec/storage-schema.sql`.
- **Go repo layout** — separate repo `whatsmulti-go` with `spec/` as a submodule is the assumption. A single polyglot monorepo is the alternative; decide before Phase 12, not before Phase 0.
- **Deno / edge support** falls out of ESM + zero deps, but is out of scope for v2.0 CI. Node and Bun are the tested targets.
- **Ship gate for v2.0.0 stable**: either Baileys reaches `7.0.0` stable, or we accept an RC we have run in production. Until then, `next` only.
