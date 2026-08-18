/**
 * Redis storage and locking.
 *
 * The client is taken as an argument and never constructed here: connection
 * management, TLS, cluster topology and reconnection policy belong to the
 * application, and a library that opens its own connection takes all of that away.
 *
 * Everything goes through `call()`, the raw-command escape hatch every ioredis-shaped
 * client exposes. That keeps this module free of any one client's overload
 * signatures, so `iovalkey` or a wrapper works as well as `ioredis` does, and a major
 * version bump on the peer is not a breaking change here.
 */
import { randomBytes } from 'node:crypto';

import { WhatsMultiError, describeError } from '../../errors.js';
import type { LockProvider, LockToken } from '../../lock.js';
import type { StorageAdapter } from '../../storage/adapter.js';

/**
 * The slice of a Redis client this needs.
 *
 * Note: do not give the client a `keyPrefix`. ioredis applies it to commands but
 * returns SCAN results unprefixed on some paths and prefixed on others, so `keys()`
 * would report keys that cannot be read back. Storage keys are already namespaced
 * under `whatsmulti:`.
 */
export interface RedisClient {
    call(command: string, ...args: (string | number)[]): Promise<unknown>;
    quit?(): Promise<unknown>;
}

export interface RedisAdapterOptions {
    readonly redis: RedisClient;
    readonly name?: string | undefined;
    /** Keys per SCAN round trip. Larger means fewer round trips and longer blocks. */
    readonly scanCount?: number | undefined;
    /**
     * Close the client on `close()`. Off by default: the connection was handed to us,
     * so shutting it down would take out everything else sharing it.
     */
    readonly closeClient?: boolean | undefined;
}

/** Redis glob metacharacters, so a key can never act as a pattern. */
function globEscape(value: string): string {
    return value.replace(/([\\*?[\]])/g, '\\$1');
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function asStringArray(value: unknown): (string | null)[] {
    return Array.isArray(value) ? value.map(asString) : [];
}

export function redisStorage(options: RedisAdapterOptions): StorageAdapter {
    const name = options.name ?? 'redis';
    const redis = options.redis;
    const count = options.scanCount ?? 500;

    const guard = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
        try {
            return await run();
        } catch (cause) {
            throw new WhatsMultiError('STORAGE_ERROR', {
                params: { adapter: name, detail: `${operation}: ${describeError(cause)}` },
                cause,
            });
        }
    };

    const parse = <T>(raw: string | null): T | null => (raw === null ? null : (JSON.parse(raw) as T));

    /**
     * Walks the keyspace with SCAN, never KEYS.
     *
     * KEYS blocks the server for the length of the scan, which on a shared Redis with
     * a large keyspace is an outage. SCAN can return duplicates across rounds, hence
     * the set.
     */
    const scan = async (prefix: string): Promise<string[]> => {
        const pattern = `${globEscape(prefix)}*`;
        const found = new Set<string>();
        let cursor = '0';

        do {
            const reply = await redis.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', count);
            if (!Array.isArray(reply) || reply.length < 2) break;

            cursor = asString(reply[0]) ?? '0';
            for (const key of asStringArray(reply[1])) if (key !== null) found.add(key);
        } while (cursor !== '0');

        return [...found];
    };

    return {
        name,

        async get<T>(key: string) {
            return guard('get', async () => parse<T>(asString(await redis.call('GET', key))));
        },

        async mget<T>(keys: string[]) {
            if (keys.length === 0) return [];
            return guard('mget', async () =>
                asStringArray(await redis.call('MGET', ...keys)).map((raw) => parse<T>(raw))
            );
        },

        async set(key: string, value: unknown) {
            await guard('set', () => redis.call('SET', key, JSON.stringify(value ?? null)));
        },

        async mset(entries) {
            if (entries.length === 0) return;
            const flat = entries.flatMap(([key, value]) => [key, JSON.stringify(value ?? null)]);
            await guard('mset', () => redis.call('MSET', ...flat));
        },

        async del(keys: string[]) {
            if (keys.length === 0) return;
            await guard('del', () => redis.call('DEL', ...keys));
        },

        async keys(prefix: string) {
            return guard('keys', () => scan(prefix));
        },

        async clear(prefix: string) {
            await guard('clear', async () => {
                const keys = await scan(prefix);
                // Chunked: one DEL with a hundred thousand arguments is a very long
                // single-threaded pause on the server.
                for (let i = 0; i < keys.length; i += 500) {
                    await redis.call('DEL', ...keys.slice(i, i + 500));
                }
            });
        },

        async close() {
            if (options.closeClient === true) await redis.quit?.();
        },
    };
}

// ------------------------------------------------------------------------- lock

/**
 * Compare-and-extend. Redis has no conditional PEXPIRE, and doing it as GET then
 * PEXPIRE from the client is not safe: between the two, our key can lapse and another
 * instance can take it, and the PEXPIRE would then extend *their* lease.
 */
export const RENEW_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
if cjson.decode(raw)['token'] ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`.trim();

/** Compare-and-delete, for the same reason: releasing someone else's lock is worse. */
export const RELEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
if cjson.decode(raw)['token'] ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`.trim();

interface LockValue {
    token: string;
    owner: string;
}

export interface RedisLockOptions extends RedisAdapterOptions {
    /** Prepended to every lock key, to share a Redis with something else. */
    readonly prefix?: string | undefined;
}

export function redisLock(options: RedisLockOptions): LockProvider {
    const name = options.name ?? 'redis';
    const redis = options.redis;
    const prefix = options.prefix ?? 'whatsmulti:lock:';
    const full = (key: string): string => prefix + key;

    const guard = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
        try {
            return await run();
        } catch (cause) {
            throw new WhatsMultiError('STORAGE_ERROR', {
                params: { adapter: name, detail: `${operation}: ${describeError(cause)}` },
                cause,
            });
        }
    };

    const readValue = (raw: string | null): LockValue | null => {
        if (raw === null) return null;
        try {
            return JSON.parse(raw) as LockValue;
        } catch {
            // Someone else's key under our prefix. Reporting it as unheld is wrong
            // and reporting it as ours is worse, so it is treated as held by nobody
            // we can name.
            return { token: '', owner: 'unknown' };
        }
    };

    return {
        name,

        async acquire(key, ttlMs, owner) {
            return guard('acquire', async () => {
                const held: LockToken = {
                    key,
                    token: randomBytes(16).toString('hex'),
                    owner,
                    expiresAt: Date.now() + ttlMs,
                };
                const value = JSON.stringify({ token: held.token, owner } satisfies LockValue);

                // NX plus PX in one command: the whole point is that taking the lock
                // and setting its expiry cannot be interrupted between the two.
                const reply = await redis.call('SET', full(key), value, 'PX', ttlMs, 'NX');
                return reply === null ? null : held;
            });
        },

        async renew(token, ttlMs) {
            return guard('renew', async () => {
                const reply = await redis.call('EVAL', RENEW_SCRIPT, 1, full(token.key), token.token, ttlMs);
                if (reply !== 1) return null;

                // Derived from our own clock rather than read back, because the server
                // does not return the new deadline and a second round trip to ask for
                // it would only be a slightly staler answer.
                return { ...token, expiresAt: Date.now() + ttlMs };
            });
        },

        async release(token) {
            await guard('release', () => redis.call('EVAL', RELEASE_SCRIPT, 1, full(token.key), token.token));
        },

        async inspect(key) {
            return guard('inspect', async () => {
                const raw = asString(await redis.call('GET', full(key)));
                const value = readValue(raw);
                if (value === null) return null;

                const ttl = await redis.call('PTTL', full(key));
                // -2 is "no such key" and -1 is "no expiry"; the key vanished between
                // the two calls in the first case, and in the second something without
                // a TTL is squatting on the name.
                if (typeof ttl !== 'number' || ttl < 0) return null;

                return { key, token: value.token, owner: value.owner, expiresAt: Date.now() + ttl };
            });
        },

        async close() {
            if (options.closeClient === true) await redis.quit?.();
        },
    };
}
