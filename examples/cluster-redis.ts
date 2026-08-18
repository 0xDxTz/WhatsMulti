/**
 * More than one replica.
 *
 * Two processes sharing a Redis: credentials in Redis so either replica can resume a
 * session, and a Redis lock so only one of them ever holds it. Two sockets on one
 * account corrupt each other's Signal state, so the lock is not an optimisation.
 *
 * Run two copies with different INSTANCE_ID values and watch one of them fence.
 *
 * Run: INSTANCE_ID=worker-1 npx tsx examples/cluster-redis.ts
 */
import { Redis } from 'ioredis';

import { WhatsMulti } from 'whatsmulti';
import { redisLock, redisStorage } from 'whatsmulti/redis';

const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379');

const client = new WhatsMulti({
    instanceId: process.env['INSTANCE_ID'] ?? 'worker-1',
    storage: redisStorage({ redis }),
    lockProvider: redisLock({ redis }),
    // The lock is renewed at renewRatio * ttlMs. A shorter TTL fails over faster and
    // costs more round trips; renewing three times per TTL survives one lost renewal.
    lock: { enabled: true, ttlMs: 30_000, renewRatio: 0.33 },
});

// The loser of the race. The socket is already closed by the time this fires -- there
// is no window in which both replicas are connected.
client.on('session.fenced', ({ owner }, { sessionId }) => {
    console.warn(`[${sessionId}] lock taken by ${owner}; this replica stood down`);
});

client.on('session.state', ({ from, to }, { sessionId }) => {
    console.log(`[${sessionId}] ${from} -> ${to}`);
});

await client.load();
await client.ensureSession('shared');
await client.start('shared');

process.on('SIGTERM', () => {
    // destroy() releases the locks, so the other replica can pick the session up
    // immediately instead of waiting out the TTL.
    void client
        .destroy()
        .then(() => redis.quit())
        .then(() => process.exit(0));
});
