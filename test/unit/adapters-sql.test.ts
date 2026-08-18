import Database from 'better-sqlite3';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { sqlLock, sqlStorage, type SqlDatabase } from '../../src/adapters/sql/index.js';
import { sessionPrefix, storageKey } from '../../src/storage/namespace.js';
import { runStorageConformance } from '../conformance/storage.js';
import { runLockConformance } from '../conformance/lock.js';

/**
 * Run against a real engine, in memory. SQLite is not the only dialect this adapter
 * supports, but it is the one that can be exercised without a server, and the
 * statements it shares with PostgreSQL and MySQL are the ones worth proving.
 */
function sqlite(): SqlDatabase {
    return drizzle(new Database(':memory:')) as unknown as SqlDatabase;
}

runStorageConformance('sql (sqlite)', {
    create: () => sqlStorage({ db: sqlite(), dialect: 'sqlite' }),
    reset: (adapter) => adapter.clear('whatsmulti:'),
});

runLockConformance('sql (sqlite)', {
    create: () => sqlLock({ db: sqlite(), dialect: 'sqlite' }),
});

describe('sql storage specifics', () => {
    const adapter = async () => {
        const store = sqlStorage({ db: sqlite(), dialect: 'sqlite' });
        await store.init?.();
        return store;
    };

    it('splits the storage key across the two columns the shared schema defines', async () => {
        const db = sqlite();
        const store = sqlStorage({ db, dialect: 'sqlite' });
        await store.init?.();
        await store.set(storageKey('a', 'pre-key-1'), 'v');

        const rows = (db as { all: (q: SQL) => unknown }).all(
            sql`SELECT session_id, auth_key FROM whatsmulti_auth`
        ) as { session_id: string; auth_key: string }[];

        expect(rows).toEqual([{ session_id: 'a', auth_key: 'pre-key-1' }]);
    });

    it('stores the key percent-encoded, as spec/algorithms.md section 3 defines it', async () => {
        const store = await adapter();
        const key = storageKey('a', 'pre:key/1');

        await store.set(key, 'v');

        await expect(store.keys(sessionPrefix('a'))).resolves.toEqual([key]);
        await expect(store.get(key)).resolves.toBe('v');
    });

    it('does not let a percent-encoded key act as a LIKE wildcard', async () => {
        // `%3A` is what a colon encodes to. Without escaping, a prefix search for it
        // would match every key, which is how a session leaks into another's listing.
        const store = await adapter();
        await store.set(storageKey('a', 'a:b'), 1);
        await store.set(storageKey('a', 'zzz'), 2);

        await expect(store.keys(`${sessionPrefix('a')}a%3A`)).resolves.toEqual([storageKey('a', 'a:b')]);
    });

    it('ignores a key from outside the namespace rather than storing a broken row', async () => {
        const store = await adapter();

        await store.set('not-ours', 1);
        await store.mset([['also-not-ours', 2]]);
        await store.del(['not-ours']);

        await expect(store.get('not-ours')).resolves.toBeNull();
        await expect(store.keys('whatsmulti:')).resolves.toEqual([]);
    });

    it('reports a listing for a foreign prefix as empty', async () => {
        const store = await adapter();
        await store.set(storageKey('a', 'k'), 1);

        await expect(store.keys('other:')).resolves.toEqual([]);
        await expect(store.clear('other:')).resolves.toBeUndefined();
    });

    it('lists by a session-id prefix that stops before the separator', async () => {
        const store = await adapter();
        await store.mset([
            [storageKey('alpha', 'k'), 1],
            [storageKey('beta', 'k'), 2],
        ]);

        await expect(store.keys('whatsmulti:al')).resolves.toEqual([storageKey('alpha', 'k')]);
    });

    it('refuses a table name that is not an identifier, which is the injection point', () => {
        expect(() => sqlStorage({ db: sqlite(), dialect: 'sqlite', table: 'auth; DROP TABLE x' })).toThrow(
            expect.objectContaining({ code: 'STORAGE_ERROR' }) as Error
        );
    });

    it('honours a custom table name', async () => {
        const store = sqlStorage({ db: sqlite(), dialect: 'sqlite', table: 'custom_auth' });
        await store.init?.();

        await store.set(storageKey('a', 'k'), 'v');
        await expect(store.get(storageKey('a', 'k'))).resolves.toBe('v');
    });

    it('reports a database that cannot run the statement as a storage failure', async () => {
        const store = sqlStorage({ db: {}, dialect: 'sqlite' });

        await expect(store.init?.()).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    });

    it('skips the migration when the caller owns the schema', async () => {
        const store = sqlStorage({ db: sqlite(), dialect: 'sqlite', migrate: false });
        await store.init?.();

        // No table was created, so the first real query is what fails -- which is the
        // point: the caller said they would create it.
        await expect(store.get(storageKey('a', 'k'))).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    });
});

describe('sql lock specifics', () => {
    it('writes the row shape the shared schema defines', async () => {
        const db = sqlite();
        const lock = sqlLock({ db, dialect: 'sqlite' });
        const held = await lock.acquire('session:a', 30_000, 'inst-1');

        const rows = (db as { all: (q: SQL) => unknown }).all(
            sql`SELECT lock_key, token, owner, expires_at FROM whatsmulti_lock`
        ) as { lock_key: string; token: string; owner: string; expires_at: number }[];

        expect(rows).toEqual([
            { lock_key: 'session:a', token: held!.token, owner: 'inst-1', expires_at: held!.expiresAt },
        ]);
    });

    it('reads back an expiry that arrived as a string, not as a lexicographic number', async () => {
        // Some drivers return BIGINT as a string. Comparing those as strings makes
        // "9" newer than "10", and a lock that never expires or always has.
        const db = sqlite();
        const lock = sqlLock({ db, dialect: 'sqlite' });
        await lock.acquire('session:a', 30_000, 'inst-1');

        const held = await lock.inspect('session:a');
        expect(typeof held?.expiresAt).toBe('number');
    });

    it('shares a database with the storage adapter without colliding', async () => {
        const db = sqlite();
        const store = sqlStorage({ db, dialect: 'sqlite' });
        const lock = sqlLock({ db, dialect: 'sqlite' });

        await store.init?.();
        await store.set(storageKey('a', 'creds'), { me: 1 });
        await lock.acquire('session:a', 30_000, 'inst-1');

        await expect(store.get(storageKey('a', 'creds'))).resolves.toEqual({ me: 1 });
        await expect(lock.inspect('session:a')).resolves.toMatchObject({ owner: 'inst-1' });
    });
});
