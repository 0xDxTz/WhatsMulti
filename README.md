# whatsmulti

Multi-session WhatsApp orchestration for Node.js, built on
[Baileys](https://github.com/WhiskeySockets/Baileys).

[![npm](https://img.shields.io/npm/v/whatsmulti?color=%23CB3837)](https://www.npmjs.com/package/whatsmulti)
[![npm downloads](https://img.shields.io/npm/dw/whatsmulti?label=downloads&color=%23CB3837)](https://www.npmjs.com/package/whatsmulti)
[![node](https://img.shields.io/node/v/whatsmulti?label=node)](https://nodejs.org)

> **v2 is a full rewrite and is breaking**, and the package moved:
> v1 was published as `@dutakey/whatsmulti` and stays there, unchanged. v2 lives here,
> unscoped, as `whatsmulti`.
> Coming from v1, read [`MIGRATION.md`](MIGRATION.md) — the API changed shape, not
> just names.

```sh
npm install whatsmulti @whiskeysockets/baileys
```

---

## What this is

A **multi-session orchestration layer over a WhatsApp Web protocol driver**. It owns
four things and deliberately nothing else:

1. **Session lifecycle** — create, start, stop, restart, logout, delete N connections
   in one process, deterministically.
2. **Auth persistence** — pluggable storage with identical semantics on every backend.
3. **Event routing** — every driver event, plus lifecycle events, tagged with a
   `sessionId`.
4. **Safe sending** — JID normalisation, a per-session queue, backpressure.

It is not a bot framework, not a fork of Baileys, and not a message store. The raw
socket stays exposed (`client.session(id).socket`) precisely so the parts this package
does not wrap remain reachable.

Everything else — webhooks, REST, database adapters, QR rendering — lives behind a
subpath export and costs nothing until it is imported.

| Import               | Contains                              | Peer                      |
| -------------------- | ------------------------------------- | ------------------------- |
| `whatsmulti`         | sessions, auth, events, messaging     | `@whiskeysockets/baileys` |
| `whatsmulti/qr`      | QR to terminal / SVG / PNG / data URL | `qrcode`                  |
| `whatsmulti/mongo`   | MongoDB storage + lock                | `mongodb`                 |
| `whatsmulti/redis`   | Redis storage + lock                  | `ioredis`                 |
| `whatsmulti/sql`     | PostgreSQL / MySQL / SQLite + lock    | `drizzle-orm` + a driver  |
| `whatsmulti/webhook` | signed HTTP event forwarder           | none                      |
| `whatsmulti/server`  | REST + SSE control plane              | `hono`                    |

The core has **zero runtime dependencies**. A missing optional peer throws a typed
`MISSING_PEER` error naming the exact install command, rather than a module-resolution
stack trace.

---

## Requirements

- **Node >= 20** (also tested on Bun). ESM only — `require()` is not supported.
- **Baileys `>=7.0.0-rc14 <8`**, installed by you. It is a peer dependency so that you
  own the version, including a fork or a pin. v7 is required: it introduces the LID
  identity system and three auth key types a v6-shaped auth state cannot persist.

---

## Quick start

This renders a QR in the terminal, which needs the `qrcode` peer:
`npm install qrcode`. Pairing with a code instead needs no extra peer — see
[`pairing-code.ts`](examples/pairing-code.ts).

```ts
import { WhatsMulti } from 'whatsmulti';
import { printQr } from 'whatsmulti/qr';

const client = new WhatsMulti({
    storage: 'file', // the default; credentials survive a restart
    logLevel: 'info',
});

client.on('qr', ({ qr }, { sessionId }) => {
    console.log(`[${sessionId}] scan this`);
    void printQr(qr);
});

client.on('session.state', ({ from, to }, { sessionId }) => {
    console.log(`[${sessionId}] ${from} -> ${to}`);
});

client.on('messages.upsert', async ({ messages }, { sessionId }) => {
    const message = messages[0];
    if (!message?.key.remoteJid || message.key.fromMe) return;
    if (message.message?.conversation !== 'ping') return;

    await client.send(sessionId, message.key.remoteJid, { text: 'pong' });
});

await client.createSession('personal');
await client.start('personal');

process.on('SIGINT', () => void client.destroy().then(() => process.exit(0)));
```

`start()` resolves once the socket is wired, **not** once the connection is open — an
unpaired session waits in `awaiting_scan` for a scan that may never come. Wait on the
`open` event, or on `session.state`, for that.

More in [`examples/`](examples).

---

## Sessions

```ts
await client.createSession('sales'); // register; storage is prepared
await client.ensureSession('sales'); // or: create, or return the existing one
await client.start('sales'); // open the socket
await client.stop('sales'); // close it; the device stays linked
await client.restart('sales');
await client.logout('sales'); // unlink from the phone, then drop local data
await client.remove('sales'); // drop local data; the device stays linked
```

**`logout` and `remove` are different operations.** v1 had one call doing both, so
asking for local cleanup silently unlinked the phone. Removing a session leaves the
device paired; logging out ends the pairing and cannot be undone without a new scan.
A failed unlink keeps the credentials so the logout can be retried.

Introspection:

```ts
client.ids(); // registered session ids
client.has('sales');
client.size;
client.find('sales'); // Session | undefined
client.session('sales'); // Session, or throws SESSION_NOT_FOUND
client.session('sales').state; // 'idle' | 'connecting' | 'awaiting_scan' | 'open' | ...
client.session('sales').socket; // the raw Baileys socket, once open
client.session('sales').queueSize;

await client.meta('sales'); // { sessionId, storage, createdAt, updatedAt } | null
await client.discover(); // ids in storage, including ones never opened here
await client.load(); // register every stored session, with bounded fan-out
```

### The state machine

```
idle ──▶ connecting ──▶ awaiting_scan ──▶ open ──▶ closing ──▶ closed
                                                      │
                                                      ▼
                                                 logged_out
```

States, triggers and legal transitions are compiled from
[`spec/states.yaml`](spec/states.yaml) — they are not hand-written here and are
identical in the planned Go build. An illegal transition throws `ILLEGAL_TRANSITION`
rather than silently corrupting the session's idea of itself.

### Reconnection

Every disconnect cause is mapped to one of three actions — reconnect, purge
credentials, or stop — from [`spec/disconnect-causes.yaml`](spec/disconnect-causes.yaml).
Reconnects use full-jitter exponential backoff, verified against shared vectors.

```ts
new WhatsMulti({
    reconnect: {
        enabled: true,
        baseMs: 1_000,
        capMs: 60_000,
        floorMs: 250,
        maxAttempts: 0, // 0 = unlimited
    },
});
```

A `loggedOut` disconnect purges the credentials instead of retrying. v1 reconnected
only on `restartRequired`, immediately and forever, and never purged — so a device
unlinked from the phone became an infinite reconnect loop against credentials that
could never work again.

---

## Events

Two kinds, one bus. **Lifecycle events** are ours; **driver events** keep their native
Baileys names, because renaming `messages.upsert` would buy nothing and break every
existing handler.

Every listener receives `(data, meta)`, where `meta` is
`{ sessionId, instanceId, ts, socket? }`.

| Lifecycle event        | Payload                            |
| ---------------------- | ---------------------------------- |
| `qr`                   | `{ qr, attempt, expiresAt }`       |
| `pairing.code`         | `{ code, phoneNumber, expiresAt }` |
| `session.created`      | `{ storage }`                      |
| `session.state`        | `{ from, to, reason? }`            |
| `session.reconnecting` | `{ attempt, delayMs, cause }`      |
| `session.logged_out`   | `{ cause }`                        |
| `session.removed`      | `{ reason }`                       |
| `session.fenced`       | `{ owner }`                        |
| `session.error`        | `{ code, message }`                |

```ts
client.on('session.reconnecting', ({ attempt, delayMs, cause }, { sessionId }) => {
    console.warn(`[${sessionId}] ${cause}: retry ${attempt} in ${delayMs}ms`);
});

client.once('open', (_, { sessionId }) => console.log(`${sessionId} connected`));
client.off('qr', handler);
```

`process()` receives the driver's **buffered batch** intact, which is what Baileys
works to provide and what v1 discarded by re-splitting it:

```ts
const unsubscribe = client.process((batch, meta) => {
    for (const [name, payload] of Object.entries(batch)) {
        console.log(meta.sessionId, name, payload);
    }
});
```

A listener that rejects is caught and logged as `LISTENER_FAILED`; it never becomes an
unhandled rejection that takes the process down.

---

## Sending

```ts
const sent = await client.send('sales', '628123456789', { text: 'hello' });
await client.send('sales', '628123456789@s.whatsapp.net', { image: buffer, caption: 'hi' });
await client.send('sales', '12036304@g.us', { text: 'to the group' });
```

Recipients are normalised: a bare phone number becomes a JID, `+`, spaces and dashes
are stripped, and a malformed one throws `INVALID_JID` or `INVALID_PHONE_NUMBER`
before anything reaches the driver.

Sends are **serialised per session** through a bounded queue. Two in flight at once
mutate the same Signal session state concurrently, and the loser produces a message the
recipient cannot decrypt. The queue also refuses work when full instead of growing
until the process runs out of memory:

```ts
new WhatsMulti({
    send: {
        concurrency: 1, // per session; leave at 1 unless you know why
        minDelayMs: 0, // spacing between sends, for rate limiting
        timeoutMs: 30_000,
        maxQueue: 1000, // beyond this, send() throws SEND_FAILED
    },
});
```

Media:

```ts
const buffer = await client.downloadMedia('sales', message);
const stream = await client.downloadMediaStream('sales', message); // never fully in memory
```

An expired media URL is refreshed through the driver's re-upload path rather than
becoming a permanent failure.

---

## Pairing: QR or an 8-digit code

QR is the default. `whatsmulti/qr` renders it — Baileys 7 removed
`printQRInTerminal`, and this replaces it:

```ts
import { printQr, toTerminal, toSvg, toBuffer, toDataURL } from 'whatsmulti/qr';

client.on('qr', async ({ qr, attempt, expiresAt }) => {
    await printQr(qr); // to stdout
    const png = await toBuffer(qr); // Buffer, for an HTTP response
});
```

`new WhatsMulti({ qr: { print: true } })` wires `printQr` for every session, if that is
all you need. `qr.timeoutMs` and `qr.maxAttempts` are honoured — v1 declared them in
its types and never read them.

Phone pairing codes need a started session that has produced at least one QR; the code
is bound to that QR reference, which is also why it expires with it:

```ts
await client.start('sales');
const code = await client.requestPairingCode('sales', '628123456789'); // 'ABCD-1234'
```

---

## Storage

Five backends, one contract, one conformance suite they all pass.

```ts
import { memoryStorage, fileStorage } from 'whatsmulti';

new WhatsMulti({ storage: 'file' }); // ./whatsmulti_sessions
new WhatsMulti({ storage: fileStorage({ path: '/var/lib/wa' }) });
new WhatsMulti({ storage: 'memory' }); // tests, and nothing else
```

```ts
import { MongoClient } from 'mongodb';
import { mongoStorage, mongoLock } from 'whatsmulti/mongo';

const mongo = await new MongoClient(process.env.MONGO_URL!).connect();
const db = mongo.db('whatsmulti');

new WhatsMulti({ storage: mongoStorage({ db }), lockProvider: mongoLock({ db }) });
```

```ts
import { Redis } from 'ioredis';
import { redisStorage, redisLock } from 'whatsmulti/redis';

const redis = new Redis(process.env.REDIS_URL!);
new WhatsMulti({ storage: redisStorage({ redis }), lockProvider: redisLock({ redis }) });
```

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { sqlStorage, sqlLock } from 'whatsmulti/sql';

const db = drizzle(process.env.DATABASE_URL!);
new WhatsMulti({
    storage: sqlStorage({ db, dialect: 'pg' }), // 'pg' | 'mysql' | 'sqlite'
    lockProvider: sqlLock({ db, dialect: 'pg' }),
});
```

A per-session override is possible, and is how one process can keep different accounts
in different places:

```ts
await client.createSession('archive', { storage: fileStorage({ path: '/mnt/cold' }) });
```

### Writing your own

Implement `StorageAdapter` and run the shared conformance suite against it. If that is
green, the adapter is finished:

```ts
import type { StorageAdapter } from 'whatsmulti';

const myStorage: StorageAdapter = {
    name: 'mine',
    async init() {},
    async get(key) {
        /* ... */
    },
    async mget(keys) {
        /* one entry per key, in order, null for anything missing */
    },
    async set(key, value) {},
    async mset(entries) {},
    async del(keys) {},
    async keys(prefix) {
        /* full keys, not suffixes */
    },
    async clear(prefix) {},
    async close() {},
};
```

`mget` and `mset` are required rather than optional: Baileys asks for thirty or more
Signal keys in one call while resuming a session, and v1 issued a round trip per key.
`init` and `close` are the only optional members.

The suite lives in [`test/conformance/storage.ts`](test/conformance/storage.ts), and
the lock counterpart in [`test/conformance/lock.ts`](test/conformance/lock.ts); the key
layout they enforce is specified in [`spec/algorithms.md`](spec/algorithms.md) §3.

---

## Running more than one replica

Sessions are fenced by a distributed lock. The lock is taken **before** the socket
opens, renewed on a heartbeat, and losing it closes the socket immediately and emits
`session.fenced`. Two replicas cannot hold the same session, which matters because two
sockets on one account corrupt each other's Signal state.

```ts
new WhatsMulti({
    lockProvider: redisLock({ redis }), // or mongoLock / sqlLock
    lock: { enabled: true, ttlMs: 30_000, renewRatio: 0.33 },
});
```

The default is an **in-process** provider: it fences this client's sessions against
each other and nothing else. One replica, one process — fine. Anything more needs a
real provider.

The lock row shape is the one in
[`spec/storage-schema.sql`](spec/storage-schema.sql), so a Go instance and a
TypeScript instance sharing a database fence each other.

---

## Webhook forwarding

```ts
import { webhook } from 'whatsmulti/webhook';

client.use(
    webhook({
        url: 'https://example.com/hooks/whatsapp',
        secret: process.env.WEBHOOK_SECRET!,
        events: ['message.received', 'session.state'], // omit to forward everything
        batchWindowMs: 0,
        retry: { maxAttempts: 5, baseMs: 1_000, capMs: 60_000 },
        onDeadLetter: (letter) => console.error('dropped', letter.reason, letter.events),
    })
);
```

Deliveries are posted **one at a time, in order**, retried on the same full-jitter
schedule as reconnects, and signed:

```
x-whatsmulti-signature: t=1755500000,v1=<hex>
signedPayload = "<t>.<raw body>"
v1            = lowercase_hex(HMAC_SHA256(secret, signedPayload))
```

`t` is reused unchanged across retries, so a retry re-sends identical bytes. Verify in
constant time and reject a timestamp outside your tolerance (300s is the default we
document). The full envelope and the verification recipe are in
[`spec/webhook.md`](spec/webhook.md); `verifySignature` is exported for a Node
receiver.

Events that never cross the wire (`creds.update`, and friends) are not forwarded, and
driver-native names are normalised to their canonical wire names — a receiver written
against the Go build works unchanged.

---

## REST + SSE control plane

An optional HTTP surface, on Hono, so a non-Node service can drive sessions:

```ts
import { serve } from '@hono/node-server';
import { createServer } from 'whatsmulti/server';

const app = await createServer({
    client,
    token: process.env.API_TOKEN!, // or a list, to rotate without a restart
    version: '2.0.0',
});

serve({ fetch: app.fetch, port: 3000 });
```

`app.fetch` is a web-standard handler: `@hono/node-server`, `Bun.serve` and
`Deno.serve` all take it directly.

| Method   | Route                         |
| -------- | ----------------------------- |
| `GET`    | `/sessions`                   |
| `POST`   | `/sessions`                   |
| `GET`    | `/sessions/{id}`              |
| `DELETE` | `/sessions/{id}`              |
| `POST`   | `/sessions/{id}/start`        |
| `POST`   | `/sessions/{id}/stop`         |
| `POST`   | `/sessions/{id}/restart`      |
| `POST`   | `/sessions/{id}/logout`       |
| `GET`    | `/sessions/{id}/qr`           |
| `POST`   | `/sessions/{id}/pairing-code` |
| `POST`   | `/sessions/{id}/messages`     |
| `GET`    | `/events` (SSE)               |
| `GET`    | `/healthz`                    |
| `GET`    | `/metrics` (Prometheus)       |

Authentication is on by default and bearer-based; serving without it takes an explicit
`insecure: true`, and passing both a token and `insecure` is refused rather than
resolved. `/healthz` and `/metrics` stay open — a liveness probe and a scraper are not
API clients.

Every response, including failures, carries the same `Error` shape, and the status per
error code lives in [`spec/errors.yaml`](spec/errors.yaml) rather than in the server —
an API client branching on 409 vs 422 never has to ask which runtime it is talking to.
The contract itself is [`spec/openapi.yaml`](spec/openapi.yaml), and the test suite
validates real responses against it.

Stream frames are encoded by the webhook's own encoder, so a stream frame and a
delivery describe the same event with the same bytes:

```sh
curl -N -H "Authorization: Bearer $API_TOKEN" \
  'http://localhost:3000/events?session=sales&events=message.received'
```

---

## Configuration

Every key, its type and its default live in [`spec/config.yaml`](spec/config.yaml); a
test asserts the defaults below equal the spec, so this build and the Go one cannot
disagree about what "default" means. Configuration is validated and frozen at
construction — an unknown value throws `INVALID_CONFIG` immediately.

```ts
const client = new WhatsMulti({
    instanceId: 'worker-1', // defaults to host:pid:random
    logger: pino(), // any pino-compatible logger
    logLevel: 'info',
    driverLogLevel: 'silent',

    storage: 'file',
    lockProvider: memoryLock(),
    plugins: [webhook({ url, secret })],
    socket: { browser: ['WhatsMulti', 'Chrome', '1.0'] }, // merged into every socket

    reconnect: { enabled: true, baseMs: 1_000, capMs: 60_000, floorMs: 250, maxAttempts: 0 },
    qr: { timeoutMs: 60_000, maxAttempts: 5, print: false },
    pairing: { enabled: false, showNotification: true, clientDisplayName: 'Chrome (Linux)' },
    send: { concurrency: 1, minDelayMs: 0, timeoutMs: 30_000, maxQueue: 1000 },
    lock: { enabled: true, ttlMs: 30_000, renewRatio: 0.33 },
    load: { concurrency: 8, autoStart: false },
});
```

Session ids must match `^[A-Za-z0-9_-]{1,64}$`. The pattern excludes `:`, `/` and `%`
on purpose, which is what makes the storage key layout exactly invertible.

---

## Errors

Every failure is a `WhatsMultiError` with a stable `code`. **Branch on the code, never
on the message** — v1 threw bare strings that had to be matched by text.

```ts
import { WhatsMultiError, isWhatsMultiError, hasErrorCode } from 'whatsmulti';

try {
    await client.send('sales', to, { text: 'hi' });
} catch (error) {
    if (hasErrorCode(error, 'SESSION_NOT_READY')) {
        // retryable: the session is reconnecting
    } else if (isWhatsMultiError(error) && error.retryable) {
        // ...
    }
}
```

| Code                    | Retryable | HTTP |
| ----------------------- | --------- | ---- |
| `SESSION_NOT_FOUND`     | no        | 404  |
| `SESSION_EXISTS`        | no        | 409  |
| `INVALID_SESSION_ID`    | no        | 422  |
| `SESSION_NOT_READY`     | yes       | 409  |
| `SESSION_LOCKED`        | yes       | 409  |
| `SESSION_LOGGED_OUT`    | no        | 409  |
| `SESSION_FAILED`        | yes       | 500  |
| `STORAGE_ERROR`         | yes       | 500  |
| `SEND_FAILED`           | yes       | 503  |
| `LOGOUT_FAILED`         | yes       | 502  |
| `MEDIA_DOWNLOAD_FAILED` | yes       | 502  |
| `TIMEOUT`               | yes       | 504  |
| `MISSING_PEER`          | no        | 501  |
| `INVALID_CONFIG`        | no        | 422  |
| `CLIENT_DESTROYED`      | no        | 503  |
| `PAIRING_UNAVAILABLE`   | yes       | 409  |
| `PAIRING_IN_PROGRESS`   | no        | 409  |
| `INVALID_PHONE_NUMBER`  | no        | 422  |
| `INVALID_JID`           | no        | 422  |
| `LISTENER_FAILED`       | no        | 500  |
| `ILLEGAL_TRANSITION`    | no        | 409  |

The REST surface adds `INVALID_REQUEST` (400), `UNAUTHORIZED` (401), `ROUTE_NOT_FOUND`
(404) and `INTERNAL_ERROR` (500). The authoritative list is
[`spec/errors.yaml`](spec/errors.yaml).

---

## Shutdown

```ts
await client.destroy();
```

Stops every session, closes every adapter, disposes every plugin, and continues past
individual failures. Ordered so plugins are still live while sessions shut down — a
webhook forwarder has to see the final events, and flush them, before it is torn down.
Idempotent, and safe to call from a signal handler. v1 had no shutdown path at all.

---

## The spec, and the Go port

[`spec/`](spec) is a language-neutral contract: the session state machine, the
disconnect cause table, error codes, event names, config keys, the REST contract, the
webhook envelope, and the shared metadata and lock schema. Enums are **generated** into
`src/generated/` — writing an enum twice is how two runtimes drift — and
[`spec/vectors/`](spec/vectors) is the parity gate every implementation runs in its own
suite.

A Go implementation (`whatsmulti-go`, on
[whatsmeow](https://github.com/tulir/whatsmeow)) is a first-class target and consumes
this directory as a submodule. What is deliberately **not** shared is Signal auth
storage: whatsmeow owns its `sqlstore` schema and Baileys owns its
`AuthenticationCreds` shape, so a session paired under one runtime cannot be resumed by
the other.

---

## Development

```sh
npm ci
npm run check        # gen:check + lint + typecheck + test
npm run coverage
npm run build
npm run verify:pack  # publint + attw on the real tarball
npm run docs         # typedoc -> docs/api
```

Anything under `spec/` requires a `spec/VERSION` bump; CI enforces it, and refuses to
build if `src/generated/` and `spec/` have drifted apart.

Releases are manual: bump `version`, write the `CHANGELOG.md` entry, then
`git tag v2.0.0 && git push --tags`. The workflow refuses to publish when the tag and
`package.json` disagree, and routes any prerelease to the `next` dist-tag.

---

## License

[MIT](LICENSE) © DxTz Dev
