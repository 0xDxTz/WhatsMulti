import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { redisLock, redisStorage, type RedisClient } from '../../src/adapters/redis/index.js';
import { sessionPrefix, storageKey } from '../../src/storage/namespace.js';
import { FakeRedis } from '../fixtures/fake-redis.js';
import { runLockConformance } from '../conformance/lock.js';
import { runStorageConformance } from '../conformance/storage.js';

runStorageConformance('redis', {
    create: () => redisStorage({ redis: new FakeRedis(), scanCount: 7 }),
    reset: (adapter) => adapter.clear('whatsmulti:'),
});

runLockConformance('redis', { create: () => redisLock({ redis: new FakeRedis() }) });

describe('the client contract', () => {
    it('accepts a real ioredis client', () => {
        // A compile-time assertion. `call` is the only method the adapter uses, which
        // is what keeps this from breaking on an ioredis major bump -- and what lets a
        // compatible client such as iovalkey be passed instead.
        const accepts = (_client: RedisClient): void => undefined;
        accepts(null as unknown as Redis);

        expect(typeof Redis).toBe('function');
    });
});

describe('redis storage specifics', () => {
    const store = (redis: FakeRedis = new FakeRedis()) => ({ redis, adapter: redisStorage({ redis }) });

    it('walks the keyspace with SCAN, never KEYS', async () => {
        // KEYS blocks the server for the whole scan, which on a shared Redis with a
        // large keyspace is an outage rather than a slow query.
        const { redis, adapter } = store();
        await adapter.set(storageKey('a', 'k'), 1);

        await adapter.keys(sessionPrefix('a'));

        expect(redis.commands).toContain('SCAN');
        expect(redis.commands).not.toContain('KEYS');
    });

    it('pages through a cursor rather than assuming one round trip', async () => {
        const adapter = redisStorage({ redis: new FakeRedis(), scanCount: 3 });
        const keys = Array.from({ length: 20 }, (_, i) => storageKey('a', `k${i}`));
        await adapter.mset(keys.map((key) => [key, 1] as const));

        await expect(adapter.keys(sessionPrefix('a'))).resolves.toHaveLength(20);
    });

    it('does not let a key act as a glob pattern', async () => {
        // Redis MATCH is a glob, and `[` or `*` in a prefix would silently widen or
        // narrow the scan.
        const { adapter } = store();
        await adapter.set(storageKey('a', 'a[b]'), 1);
        await adapter.set(storageKey('a', 'ab'), 2);

        await expect(adapter.keys(`${sessionPrefix('a')}a[b]`)).resolves.toEqual([storageKey('a', 'a[b]')]);
    });

    it('reports a failing client as a storage error, not as a missing value', async () => {
        const { redis, adapter } = store();
        redis.failWith = new Error('connection reset');

        await expect(adapter.get(storageKey('a', 'k'))).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    });

    it('leaves the connection alone on close, because it was handed to us', async () => {
        const { redis, adapter } = store();

        await adapter.close?.();

        expect(redis.closed).toBe(false);
    });

    it('closes the connection when the caller asked it to own one', async () => {
        const redis = new FakeRedis();
        const adapter = redisStorage({ redis, closeClient: true });

        await adapter.close?.();

        expect(redis.closed).toBe(true);
    });
});

describe('redis lock specifics', () => {
    it('takes the lock and its expiry in one command, so neither can happen alone', async () => {
        const redis = new FakeRedis();
        const lock = redisLock({ redis });

        await lock.acquire('session:a', 30_000, 'inst-1');

        expect(redis.commands).toEqual(['SET']);
    });

    it('namespaces lock keys so a Redis can be shared', async () => {
        const redis = new FakeRedis();
        const lock = redisLock({ redis, prefix: 'app:locks:' });

        await lock.acquire('session:a', 30_000, 'inst-1');

        await expect(redis.call('GET', 'app:locks:session:a')).resolves.toContain('inst-1');
    });

    it('reports a key it did not write as held by nobody it can name', async () => {
        // Something else is squatting on the name. Calling it free would hand out a
        // lock that is not ours to give.
        const redis = new FakeRedis();
        const lock = redisLock({ redis });
        await redis.call('SET', 'whatsmulti:lock:session:a', 'not json', 'PX', 30_000);

        await expect(lock.inspect('session:a')).resolves.toMatchObject({ owner: 'unknown' });
        await expect(lock.acquire('session:a', 30_000, 'inst-1')).resolves.toBeNull();
    });

    it('treats a key with no expiry as unheld, because nothing will ever release it', async () => {
        const redis = new FakeRedis();
        const lock = redisLock({ redis });
        await redis.call('SET', 'whatsmulti:lock:session:a', JSON.stringify({ token: 't', owner: 'ghost' }));

        await expect(lock.inspect('session:a')).resolves.toBeNull();
    });

    it('reports a failing client as an error rather than as a lost lock', async () => {
        const redis = new FakeRedis();
        const lock = redisLock({ redis });
        const held = (await lock.acquire('session:a', 30_000, 'inst-1'))!;
        redis.failWith = new Error('connection reset');

        // A backend that did not answer is not proof we were fenced; the session layer
        // retries on an error and fails stop only on a definite refusal.
        await expect(lock.renew(held, 30_000)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    });
});
