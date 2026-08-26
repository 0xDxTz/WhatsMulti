# Migrating from v1 to v2

v2 is a rewrite, not a refactor. The API changed shape: entry point, constructor
options, method names, event payloads and error handling are all different, and the
package is now ESM-only on Node >= 20 with Baileys as a peer dependency.

Budget an hour for a small integration. The mapping below is complete — if something
you used is not here, it was removed on purpose and the reason is in the last section.

---

## 1. The package moved, and the runtime changed

v1 was published as `@dutakey/whatsmulti`. v2 is published as **`whatsmulti`**, without
a scope. npm has no redirect between the two, so this is a real uninstall and install
rather than a version bump:

```sh
npm uninstall @dutakey/whatsmulti
npm install whatsmulti @whiskeysockets/baileys
```

`@dutakey/whatsmulti` keeps working exactly as it does today — nothing was unpublished,
and 1.6.1 remains installable. It simply receives no further releases.

- **Node >= 20.** v1 declared no `engines` range at all, so it installed anywhere and
  failed at runtime instead.
- **ESM only.** `@dutakey/whatsmulti` shipped a CommonJS build; `whatsmulti` does not.
  Either set `"type": "module"` in your `package.json`, rename entry files to `.mjs`,
  or reach it with a dynamic `await import(...)` from CommonJS.
- **Baileys is now yours to install.** It is a peer dependency so you own the version,
  including a fork or a pin. v2 requires the `7.0.0-rc` line: v7 introduces the LID
  identity system and three auth key types (`lid-mapping`, `device-list`, `tctoken`)
  that a v6-shaped auth state cannot persist.
- **`mongoose` is gone.** The MongoDB adapter uses the raw `mongodb` driver, and only
  if you import `whatsmulti/mongo`.
- **`pino` and `pino-pretty` are gone.** The default logger is ~30 lines with no
  dependencies; any pino-compatible logger can still be injected.

## 2. Import and construct

```diff
-const WhatsMulti = require('@dutakey/whatsmulti');
+import { WhatsMulti } from 'whatsmulti';
```

There is no default export any more. A default export that is also the only export
makes the package harder to tree-shake and impossible to extend without churn.

```diff
 const client = new WhatsMulti({
-    mongoUri: 'mongodb://localhost:27017/whatsmulti-db',
-    defaultConnectionType: 'mongodb',
-    localConnectionPath: './sessions',
-    LoggerLevel: 'info',
-    BaileysLoggerLevel: 'silent',
+    storage: mongoStorage({ db }),
+    logLevel: 'info',
+    driverLogLevel: 'silent',
 });
```

### Config keys

| v1                      | v2                              | Note                                                        |
| ----------------------- | ------------------------------- | ----------------------------------------------------------- |
| `mongoUri`              | `storage: mongoStorage({ db })` | You connect the client; we never own your connection string |
| `defaultConnectionType` | `storage`                       | `'local'` is now `'file'`; `'memory'` unchanged             |
| `localConnectionPath`   | `fileStorage({ path })`         | v1 declared this and then ignored it — see §8               |
| `LoggerLevel`           | `logLevel`                      | camelCase throughout                                        |
| `BaileysLoggerLevel`    | `driverLogLevel`                |                                                             |

Everything else is new: `reconnect`, `qr`, `pairing`, `send`, `lock`, `load`,
`instanceId`, `lockProvider`, `plugins`, `socket`. Defaults are in
[`spec/config.yaml`](spec/config.yaml). Configuration is validated and frozen at
construction, so a typo throws `INVALID_CONFIG` instead of being silently ignored.

## 3. Sessions

```diff
-await client.createSession('s1', 'mongodb', { printQR: true });
-await client.startSession('s1');
-await client.stopSession('s1');
-await client.restartSession('s1');
-await client.logoutSession('s1');
-await client.deleteSession('s1');
-await client.loadSessions();
+await client.createSession('s1');
+await client.start('s1');
+await client.stop('s1');
+await client.restart('s1');
+await client.logout('s1');
+await client.remove('s1');
+await client.load();
```

| v1                                      | v2                                              |
| --------------------------------------- | ----------------------------------------------- |
| `createSession(id, type, socketConfig)` | `createSession(id, { storage, socketOptions })` |
| `startSession(id)`                      | `start(id)`                                     |
| `stopSession(id)`                       | `stop(id)`                                      |
| `restartSession(id)`                    | `restart(id)`                                   |
| `logoutSession(id)`                     | `logout(id)`                                    |
| `deleteSession(id)`                     | `remove(id)`                                    |
| `getSession(id)` (async)                | `find(id)` / `session(id)` (sync)               |
| `getSessions()` (async)                 | `ids()` (sync) or `discover()` (async)          |
| `loadSessions()`                        | `load()`                                        |
| `getQr(id)`                             | the `qr` event — see §5                         |
| —                                       | `ensureSession(id)`, `meta(id)`, `destroy()`    |

Three behavioural changes to check for in your code:

**`deleteSession` unlinked the phone. `remove` does not.** v1's delete called
`logout()` internally, so asking for local cleanup ended the pairing. In v2 they are
separate operations: `remove()` drops local data and leaves the device linked;
`logout()` unlinks and then drops. If your v1 code called `deleteSession` to free disk
space, it was silently unpairing users, and `remove()` is what you actually wanted.

**`start()` resolves earlier than you may expect.** It resolves once the socket is
wired, not once the connection is open — an unpaired session sits in `awaiting_scan`
waiting for a scan that may never come. Wait on the `open` event, or on
`session.state`, if you need a live connection.

**`getSession` returned a plain snapshot; `session()` returns a live object.** It
throws `SESSION_NOT_FOUND` when the id is not registered; use `find()` for the
`undefined` form. `.status` is now `.state`, and it moves through a spec'd state
machine (`idle → connecting → awaiting_scan → open → closing → closed`, plus
`logged_out`) rather than mirroring Baileys' three connection strings.

## 4. Shutdown

v1 had no shutdown path, which is why it leaked in tests and on serverless. Add one:

```ts
process.on('SIGTERM', () => void client.destroy().then(() => process.exit(0)));
```

`destroy()` stops every session, closes every adapter and disposes every plugin,
continuing past individual failures. It is idempotent.

## 5. Events

Driver events keep their Baileys names — `messages.upsert` is still `messages.upsert`.
Two things changed: the connection pseudo-events, and the `qr` payload.

```diff
-client.on('connecting', (_, { sessionId }) => ...);
-client.on('open', (_, { sessionId }) => ...);
-client.on('close', (_, { sessionId }) => ...);
+client.on('session.state', ({ from, to }, { sessionId }) => {
+    if (to === 'open') ...;
+});
```

`open`, `close` and `connecting` are gone. They could not express the difference
between a socket that closed and will retry, one that closed for good, and one that
was logged out — which is exactly the distinction a caller needs. `session.state`
carries `{ from, to, reason }`, and the lifecycle list also gains
`session.reconnecting`, `session.logged_out`, `session.removed`, `session.fenced`,
`session.created` and `session.error`.

```diff
-client.on('qr', ({ image, qr }) => { /* image was a PNG data URL */ });
+client.on('qr', async ({ qr, attempt, expiresAt }) => {
+    const image = await toDataURL(qr); // from 'whatsmulti/qr'
+});
```

The QR payload no longer carries a rendered image. Rendering pulled `qrcode` into every
install, including the majority who print the QR to a terminal or forward the raw
string; it now lives behind the optional `whatsmulti/qr` subpath. `printQR`
as a socket option is replaced by `qr: { print: true }` in the constructor, or by
calling `printQr(qr)` yourself.

`getQr(id)` is gone with it. A polled getter races the QR rotation — by the time a
caller reads it the code may already have expired — so the event, which carries
`expiresAt`, is the only honest interface. If you need a pull-based one, the REST
server exposes `GET /sessions/{id}/qr`, which serves from a cache that is dropped the
moment the session opens.

The meta argument grew: `{ sessionId, socket }` is now
`{ sessionId, instanceId, ts, socket? }`.

## 6. Sending

```diff
-await client.sendMessage(sessionId, msg, { text: 'hi' });
+await client.send(sessionId, msg.key.remoteJid, { text: 'hi' }, { quoted: msg });
```

`send` takes a **recipient**, not a message. v1 accepted either a JID string or a
`WAMessage` and inferred the destination from it, which meant a typo in a variable
name sent a message to a stranger rather than failing. Quote with the driver's own
`options.quoted`.

Recipients are normalised — `+62 812-3456-789`, `628123456789` and
`628123456789@s.whatsapp.net` all resolve to the same JID — and a malformed one throws
`INVALID_JID` or `INVALID_PHONE_NUMBER` before it reaches the driver.

Sends are now serialised per session through a bounded queue. If you were sending in
parallel with `Promise.all`, you no longer need to: the queue does it, and it is there
because two concurrent sends mutate the same Signal session state and the loser
produces a message the recipient cannot decrypt. A full queue throws instead of
growing without limit.

## 7. Errors

```diff
-try { ... } catch (error) {
-    if (error.message === 'Session not found') ...;
-}
+import { hasErrorCode } from 'whatsmulti';
+try { ... } catch (error) {
+    if (hasErrorCode(error, 'SESSION_NOT_FOUND')) ...;
+}
```

v1 threw bare `Error`s with English messages, so the only way to branch was to match
the text. v2 throws `WhatsMultiError` with a stable `code`, a `retryable` flag and
structured `params`. Message text is now free to change; the code is not. The list is
in [`spec/errors.yaml`](spec/errors.yaml) and in the README.

## 8. Storage and existing credentials

**The default path is to re-pair.** v1 stored one directory per session in the process
working directory, with `/` collapsed to `__` and `:` to `-`. That escaping is not
invertible — `pre-key-5` and `pre:key:5` produced the same filename, and one silently
overwrote the other — so a faithful conversion of every Signal key is not possible.
v2's layout is percent-encoded and specified in
[`spec/algorithms.md`](spec/algorithms.md) §3.

On top of that, v1 tracked Baileys v6 and v2 requires v7. Credentials paired before the
LID migration may or may not resume; that is Baileys' business, not ours, and we will
not claim it works.

If re-pairing a fleet is not acceptable, the credential blob is the piece worth
carrying: keeping `creds` keeps the device linked, and Signal re-establishes the
per-conversation keys on demand. From your v1 storage root:

```js
// migrate-creds.mjs -- run once, with the process stopped.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const v1Root = process.argv[2] ?? '.'; // where v1's <sessionId>/ directories live
const v2Root = process.argv[3] ?? './whatsmulti_sessions';

for (const entry of await readdir(v1Root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let creds;
    try {
        creds = JSON.parse(await readFile(join(v1Root, entry.name, 'creds.json'), 'utf8'));
    } catch {
        continue; // not a session directory
    }

    // v1 wrote BufferJSON's {type:'Buffer',data:<base64>} shape, which v2 reads
    // unchanged. Only the envelope around it is new.
    await mkdir(join(v2Root, entry.name), { recursive: true });
    await writeFile(join(v2Root, entry.name, 'creds.json'), JSON.stringify({ key: 'creds', value: creds }));
    console.log('migrated', entry.name);
}
```

Verify one session before converting the rest, and keep the v1 directories until every
session has reached `open` at least once. A session that comes back `logged_out` has to
be paired again — there is no recovery from that.

The Mongo equivalent is the same idea against a different store, but v1 created **one
collection per session id** (and a global Mongoose model per session, which collided on
name); v2 uses a single namespaced collection. Read each session's `creds` document,
`JSON.parse` its `data` field, and write it as `whatsmulti:<sessionId>:creds`.

New backends worth knowing about: `whatsmulti/redis` and
`whatsmulti/sql` (PostgreSQL, MySQL, SQLite) did not exist in v1.

## 9. Removed, and why

| Removed                                         | Why                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| default export                                  | Blocks tree-shaking and makes adding a second export a breaking change                     |
| `getQr(id)`                                     | A polled getter races QR rotation; the event carries `expiresAt`                           |
| `disableQRRetry`, `qrMaxWaitMs`                 | Declared in v1's types and never read. Replaced by `qr.maxAttempts` and `qr.timeoutMs`     |
| `printQR` socket option                         | Replaced by `qr: { print: true }` and the `/qr` subpath. Baileys 7 removed its own printer |
| `scanned`                                       | Declared and never read; the state machine answers this                                    |
| `open` / `close` / `connecting` events          | Cannot express retrying vs closed vs logged out                                            |
| `sendMessage(id, msg, ...)`                     | Inferring a recipient from a message object sends to the wrong person on a typo            |
| `mongoUri`                                      | We should never own your connection string, and it forced `mongoose` on every install      |
| `mongoose`, `pino`, `pino-pretty`, `@hapi/boom` | Heavy dependencies for a key-value store, a logger and one type cast                       |
| `semantic-release`                              | Versions are now decided by a person, in lockstep with the planned Go build's git tags     |

## 10. Worth adopting once you are on v2

- **`destroy()`** in your signal handlers. v1 had no shutdown at all.
- **Pairing codes** — `requestPairingCode(id, phone)` returns `XXXX-XXXX`, so a user
  who cannot scan a screen can still link a device.
- **A distributed lock** — `lockProvider: redisLock({ redis })` and friends. Two
  replicas holding one session corrupt each other's Signal state; the lock is taken
  before the socket opens and losing it closes the socket at once.
- **`whatsmulti/webhook`** — signed, ordered, retrying HTTP delivery, instead
  of a hand-rolled `client.on(...)` that forwards with `fetch`.
- **`whatsmulti/server`** — an authenticated REST + SSE control plane, if
  something outside Node needs to drive sessions.
- **`process(listener)`** — the driver's buffered batch intact. v1 re-split it, which
  discarded the batching Baileys works to provide.

---

Something missing or wrong here? Open an issue — a gap in this document is a bug in
the release.
