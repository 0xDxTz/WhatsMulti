# Examples

Runnable, and compiled by CI — an example that no longer type checks is a bug in the
release, not a stale file. `examples/tsconfig.json` points the package name at `src/`,
so each file reads exactly as your own code would.

```sh
npm ci
npx tsx examples/basic.ts
```

| File                                         | Shows                                                            |
| -------------------------------------------- | ---------------------------------------------------------------- |
| [`basic.ts`](basic.ts)                       | One session, file storage, QR on the terminal, a reply to `ping` |
| [`pairing-code.ts`](pairing-code.ts)         | Linking with an 8-digit code instead of a QR                     |
| [`multi-session.ts`](multi-session.ts)       | Restoring stored sessions, per-session storage, bounded load     |
| [`cluster-redis.ts`](cluster-redis.ts)       | Two replicas sharing Redis, fenced by a distributed lock         |
| [`webhook.ts`](webhook.ts)                   | Signed, ordered, retrying HTTP forwarding                        |
| [`webhook-receiver.ts`](webhook-receiver.ts) | The other end: verifying a signature before trusting the payload |
| [`server.ts`](server.ts)                     | The REST + SSE control plane behind a bearer token               |

`cluster-redis.ts` needs a Redis; `webhook.ts` and `webhook-receiver.ts` are meant to
run as a pair. Everything else runs against nothing but a phone.
