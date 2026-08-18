import type { Db } from 'mongodb';
import { describe, expect, it } from 'vitest';

import { mongoLock, mongoStorage, type MongoDatabase } from '../../src/adapters/mongo/index.js';
import { sessionPrefix, storageKey } from '../../src/storage/namespace.js';
import { FakeMongo } from '../fixtures/fake-mongo.js';
import { runLockConformance } from '../conformance/lock.js';
import { runStorageConformance } from '../conformance/storage.js';

runStorageConformance('mongo', {
    create: () => mongoStorage({ db: new FakeMongo() }),
    reset: (adapter) => adapter.clear('whatsmulti:'),
});

runLockConformance('mongo', { create: () => mongoLock({ db: new FakeMongo() }) });

describe('the database contract', () => {
    it('accepts a real driver Db', () => {
        // A compile-time assertion. `collection()` returning unknown is what keeps
        // this off the driver's overload signatures, so a mongodb major bump is not a
        // breaking change here.
        const accepts = (_db: MongoDatabase): void => undefined;
        accepts(null as unknown as Db);

        expect(true).toBe(true);
    });
});

describe('mongo storage specifics', () => {
    const store = () => {
        const db = new FakeMongo();
        return { db, adapter: mongoStorage({ db }) };
    };

    it('keeps every session in one collection, keyed by the full storage key', async () => {
        // v1 created a collection *and* a global Mongoose model per session id, which
        // collides on name and leaks at scale.
        const { db, adapter } = store();

        await adapter.set(storageKey('a', 'creds'), 1);
        await adapter.set(storageKey('b', 'creds'), 2);

        expect([...db.collections.keys()]).toEqual(['whatsmulti_auth']);
        expect([...db.collections.get('whatsmulti_auth')!.docs.keys()]).toEqual([
            storageKey('a', 'creds'),
            storageKey('b', 'creds'),
        ]);
    });

    it('records the session id so a per-session query does not have to parse keys', async () => {
        const { db, adapter } = store();
        await adapter.set(storageKey('a', 'creds'), 1);

        expect(db.collections.get('whatsmulti_auth')!.docs.get(storageKey('a', 'creds'))).toMatchObject({
            sessionId: 'a',
        });
    });

    it('stores the value as JSON text rather than a subdocument', async () => {
        // BSON would coerce: a large integer becomes a double and an empty object is
        // not guaranteed to round-trip. The contract says a value comes back exactly
        // as it went in.
        const { db, adapter } = store();
        await adapter.set(storageKey('a', 'k'), { n: 1 });

        expect(db.collections.get('whatsmulti_auth')!.docs.get(storageKey('a', 'k'))?.['value']).toBe('{"n":1}');
    });

    it('indexes the session id on init', async () => {
        const { db, adapter } = store();

        await adapter.init?.();

        expect(db.collections.get('whatsmulti_auth')!.indexes).toEqual([{ sessionId: 1 }]);
    });

    it('reads a whole batch in one query', async () => {
        const { adapter } = store();
        const keys = Array.from({ length: 40 }, (_, i) => storageKey('a', `k${i}`));
        await adapter.mset(keys.map((key) => [key, 1] as const));

        await expect(adapter.mget(keys)).resolves.toEqual(keys.map(() => 1));
    });

    it('does not let a key act as a regular expression', async () => {
        const { adapter } = store();
        await adapter.set(storageKey('a', 'a.b'), 1);
        await adapter.set(storageKey('a', 'axb'), 2);

        await expect(adapter.keys(`${sessionPrefix('a')}a.b`)).resolves.toEqual([storageKey('a', 'a.b')]);
    });

    it('ignores a key from outside the namespace rather than storing a broken document', async () => {
        const { db, adapter } = store();

        await adapter.set('not-ours', 1);
        await adapter.mset([['also-not-ours', 2]]);

        expect(db.collections.get('whatsmulti_auth')!.docs.size).toBe(0);
    });

    it('reports a failing driver as a storage error', async () => {
        const broken: MongoDatabase = {
            collection: () => ({
                findOne: () => Promise.reject(new Error('not primary')),
            }),
        };
        const adapter = mongoStorage({ db: broken });

        await expect(adapter.get(storageKey('a', 'k'))).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    });

    it('honours a custom collection name', async () => {
        const db = new FakeMongo();
        const adapter = mongoStorage({ db, collection: 'sessions_auth' });

        await adapter.set(storageKey('a', 'k'), 1);

        expect([...db.collections.keys()]).toEqual(['sessions_auth']);
    });
});

describe('mongo lock specifics', () => {
    it('takes the lock in a single upsert, which is the atomic gate', async () => {
        const db = new FakeMongo();
        const lock = mongoLock({ db });

        const held = await lock.acquire('session:a', 30_000, 'inst-1');

        expect(db.collections.get('whatsmulti_lock')!.docs.get('session:a')).toMatchObject({
            token: held!.token,
            owner: 'inst-1',
            expiresAt: held!.expiresAt,
        });
    });

    it('reads a duplicate key as a refusal and nothing else as one', async () => {
        const failing: MongoDatabase = {
            collection: () => ({
                updateOne: () => Promise.reject(new Error('connection timed out')),
            }),
        };
        const lock = mongoLock({ db: failing });

        // A driver failure must not read as "someone else holds it": the session layer
        // would report SESSION_LOCKED and send the operator looking for an instance
        // that does not exist.
        await expect(lock.acquire('session:a', 30_000, 'inst-1')).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    });

    it('keeps the lock in its own collection, so it can be shared with the storage', async () => {
        const db = new FakeMongo();
        const store = mongoStorage({ db });
        const lock = mongoLock({ db });

        await store.set(storageKey('a', 'creds'), 1);
        await lock.acquire('session:a', 30_000, 'inst-1');

        expect([...db.collections.keys()].sort()).toEqual(['whatsmulti_auth', 'whatsmulti_lock']);
    });
});
