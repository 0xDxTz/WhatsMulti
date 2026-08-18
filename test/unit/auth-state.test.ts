import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthState } from '../../src/auth/auth-state.js';
import { CREDS_KEY, META_KEY, signalKey } from '../../src/auth/keys.js';
import {
    SIGNAL_KEY_TYPES,
    type SignalDataSet,
    type SignalDataTypeMap,
    type SignalKeyType,
} from '../../src/compat/baileys.js';
import { WhatsMultiError } from '../../src/errors.js';
import type { StorageAdapter } from '../../src/storage/adapter.js';
import { fileStorage } from '../../src/storage/file.js';
import { memoryStorage } from '../../src/storage/memory.js';
import { sessionPrefix, storageKey } from '../../src/storage/namespace.js';

const SESSION = 'auth_test';

/** A representative value for every v7 key type, exercised by the round-trip test. */
const SAMPLES: { [T in SignalKeyType]: SignalDataTypeMap[T] } = {
    'pre-key': { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) },
    session: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    'sender-key': Buffer.from('sender'),
    'sender-key-memory': { '628@s.whatsapp.net': true, '629@s.whatsapp.net': false },
    'app-state-sync-key': {
        keyData: Buffer.from('key-data'),
        fingerprint: { rawId: 7, currentIndex: 1, deviceIndexes: [0, 1] },
        timestamp: 1755500000000,
    },
    'app-state-sync-version': {
        version: 3,
        hash: Buffer.alloc(128, 9),
        indexValueMap: { 'aGk=': { valueMac: Buffer.from('mac') } },
    },
    'lid-mapping': '98765432109876@lid',
    'device-list': ['0', '12', '35'],
    tctoken: { token: Buffer.from('tc'), timestamp: '1755500000', senderTimestamp: 1755500000 },
    'identity-key': Buffer.from([7, 7, 7]),
};

/**
 * Compares stored against loaded without caring which concrete carrier a number or a
 * byte string arrived in: an app-state-sync-key comes back as a protobuf message,
 * whose timestamp is a Long and whose keyData is a Uint8Array. Both sides go through
 * the same normalisation, so byte content and structure are still compared exactly.
 */
function normalise(value: unknown): unknown {
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
    if (Array.isArray(value)) return value.map(normalise);
    if (typeof value === 'number') return String(value);
    if (typeof value === 'object' && value !== null) {
        if ('low' in value && 'high' in value) return (value as { toString(): string }).toString();
        return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalise(nested)]));
    }
    return value;
}

const backends: [string, () => Promise<{ storage: StorageAdapter; cleanup: () => Promise<void> }>][] = [
    ['memory', () => Promise.resolve({ storage: memoryStorage(), cleanup: () => Promise.resolve() })],
    [
        'file',
        async () => {
            const dir = await mkdtemp(join(tmpdir(), 'whatsmulti-auth-'));
            return { storage: fileStorage({ path: dir }), cleanup: () => rm(dir, { recursive: true, force: true }) };
        },
    ],
];

describe.each(backends)('useAuthState on %s storage', (_name, makeBackend) => {
    let storage: StorageAdapter;
    let cleanup: () => Promise<void>;
    const created: (() => Promise<void>)[] = [];

    beforeEach(async () => {
        ({ storage, cleanup } = await makeBackend());
        created.push(cleanup);
    });

    afterAll(async () => {
        await Promise.all(created.map((run) => run()));
    });

    it('generates credentials on first use and restores them on the next', async () => {
        const first = await useAuthState({ sessionId: SESSION, storage });
        await first.saveCreds();

        const second = await useAuthState({ sessionId: SESSION, storage });

        expect(second.state.creds.registrationId).toBe(first.state.creds.registrationId);
        expect(second.state.creds.advSecretKey).toBe(first.state.creds.advSecretKey);
        expect(Buffer.from(second.state.creds.noiseKey.private)).toEqual(
            Buffer.from(first.state.creds.noiseKey.private)
        );
    });

    it('does not persist credentials until saveCreds is called', async () => {
        const first = await useAuthState({ sessionId: SESSION, storage });
        const second = await useAuthState({ sessionId: SESSION, storage });

        expect(second.state.creds.registrationId).not.toBe(first.state.creds.registrationId);
    });

    it.each(SIGNAL_KEY_TYPES)('round-trips a %s entry', async (type) => {
        const auth = await useAuthState({ sessionId: SESSION, storage });
        const value = SAMPLES[type];

        await auth.state.keys.set({ [type]: { id1: value } });
        const read = await auth.state.keys.get(type, ['id1']);

        expect(normalise(read['id1'])).toEqual(normalise(value));
    });

    it('revives an app-state-sync-key timestamp as a protobuf Long, not a number', async () => {
        // Left as a number, Baileys' app-state decoding compares against a Long and
        // silently mis-orders key rotation.
        const auth = await useAuthState({ sessionId: SESSION, storage });
        await auth.state.keys.set({ 'app-state-sync-key': { k: SAMPLES['app-state-sync-key'] } });

        const read = await auth.state.keys.get('app-state-sync-key', ['k']);

        expect(typeof read['k']?.timestamp).toBe('object');
        expect(String(read['k']?.timestamp)).toBe('1755500000000');
    });

    it('keeps binary byte-identical through storage', async () => {
        const auth = await useAuthState({ sessionId: SESSION, storage });
        const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

        await auth.state.keys.set({ session: { peer: bytes } });
        const read = await auth.state.keys.get('session', ['peer']);

        expect(Buffer.from(read['peer'] as Uint8Array).equals(bytes)).toBe(true);
    });

    it('omits ids it has no value for, rather than returning nulls', async () => {
        const auth = await useAuthState({ sessionId: SESSION, storage });
        await auth.state.keys.set({ 'pre-key': { '1': SAMPLES['pre-key'] } });

        const read = await auth.state.keys.get('pre-key', ['1', '2']);

        expect(Object.keys(read)).toEqual(['1']);
    });

    it('treats a null value as a delete', async () => {
        const auth = await useAuthState({ sessionId: SESSION, storage });
        await auth.state.keys.set({ session: { peer: SAMPLES['session'] } });

        await auth.state.keys.set({ session: { peer: null } });

        expect(await auth.state.keys.get('session', ['peer'])).toEqual({});
    });

    it('namespaces every key under the session', async () => {
        const auth = await useAuthState({ sessionId: SESSION, storage });
        await auth.saveCreds();
        await auth.state.keys.set({ 'lid-mapping': { '628': '99@lid' } });

        const keys = await storage.keys(sessionPrefix(SESSION));

        expect(keys).toContain(storageKey(SESSION, CREDS_KEY));
        expect(keys).toContain(storageKey(SESSION, signalKey('lid-mapping', '628')));
    });

    it('isolates one session from another', async () => {
        const a = await useAuthState({ sessionId: 'a_1', storage });
        const b = await useAuthState({ sessionId: 'b_1', storage });
        await a.state.keys.set({ session: { peer: Buffer.from('a') } });

        expect(await b.state.keys.get('session', ['peer'])).toEqual({});
    });

    it('clears Signal keys while leaving credentials and metadata in place', async () => {
        const auth = await useAuthState({ sessionId: SESSION, storage });
        await auth.saveCreds();
        await storage.set(storageKey(SESSION, META_KEY), { backend: 'test' });
        await auth.state.keys.set({ session: { peer: Buffer.from('x') }, 'pre-key': { '1': SAMPLES['pre-key'] } });

        await auth.clearKeys();

        expect(await auth.state.keys.get('session', ['peer'])).toEqual({});
        expect(await storage.get(storageKey(SESSION, CREDS_KEY))).not.toBeNull();
        expect(await storage.get(storageKey(SESSION, META_KEY))).toEqual({ backend: 'test' });
    });

    it('exposes the same reset through the Baileys clear() hook', async () => {
        const auth = await useAuthState({ sessionId: SESSION, storage });
        await auth.saveCreds();
        await auth.state.keys.set({ session: { peer: Buffer.from('x') } });

        await auth.state.keys.clear?.();

        expect(await auth.state.keys.get('session', ['peer'])).toEqual({});
        expect(await storage.get(storageKey(SESSION, CREDS_KEY))).not.toBeNull();
    });

    it('clears nothing when there are no Signal keys', async () => {
        const auth = await useAuthState({ sessionId: SESSION, storage });
        await auth.saveCreds();

        await expect(auth.clearKeys()).resolves.toBeUndefined();
        expect(await storage.get(storageKey(SESSION, CREDS_KEY))).not.toBeNull();
    });

    it('purge removes credentials, keys and metadata', async () => {
        const auth = await useAuthState({ sessionId: SESSION, storage });
        await auth.saveCreds();
        await storage.set(storageKey(SESSION, META_KEY), { backend: 'test' });
        await auth.state.keys.set({ session: { peer: Buffer.from('x') } });

        await auth.purge();

        expect(await storage.keys(sessionPrefix(SESSION))).toEqual([]);
    });
});

describe('useAuthState batching', () => {
    it('reads a whole batch in one adapter call', async () => {
        // v1 issued one round trip per id; Baileys asks for thirty or more while
        // resuming a session.
        const inner = memoryStorage();
        const mget = vi.spyOn(inner, 'mget');
        const auth = await useAuthState({ sessionId: SESSION, storage: inner });
        const ids = Array.from({ length: 30 }, (_, i) => `id${i}`);
        await auth.state.keys.set({ session: Object.fromEntries(ids.map((id) => [id, Buffer.from(id)])) });
        mget.mockClear();

        await auth.state.keys.get('session', ids);

        expect(mget).toHaveBeenCalledTimes(1);
        expect(mget.mock.calls[0]?.[0]).toHaveLength(30);
    });

    it('writes a whole batch in one adapter call, and deletes in one more', async () => {
        const inner = memoryStorage();
        const mset = vi.spyOn(inner, 'mset');
        const del = vi.spyOn(inner, 'del');
        const auth = await useAuthState({ sessionId: SESSION, storage: inner });

        await auth.state.keys.set({
            session: { a: Buffer.from('a'), b: Buffer.from('b'), gone: null },
            'pre-key': { '1': SAMPLES['pre-key'] },
        });

        expect(mset).toHaveBeenCalledTimes(1);
        expect(mset.mock.calls[0]?.[0]).toHaveLength(3);
        expect(del).toHaveBeenCalledTimes(1);
        expect(del.mock.calls[0]?.[0]).toHaveLength(1);
    });

    it('touches the adapter for neither write nor delete when handed nothing', async () => {
        const inner = memoryStorage();
        const mset = vi.spyOn(inner, 'mset');
        const del = vi.spyOn(inner, 'del');
        const auth = await useAuthState({ sessionId: SESSION, storage: inner });

        // SignalDataSet marks every type optional, so an absent section really does
        // arrive as undefined; exactOptionalPropertyTypes just refuses to write it.
        await auth.state.keys.set({ session: {}, 'pre-key': undefined } as unknown as SignalDataSet);

        expect(mset).not.toHaveBeenCalled();
        expect(del).not.toHaveBeenCalled();
    });
});

describe('useAuthState failures', () => {
    it('rejects an invalid session id before touching storage', async () => {
        const storage = memoryStorage();
        const init = vi.spyOn(storage, 'get');

        await expect(useAuthState({ sessionId: 'bad id', storage })).rejects.toMatchObject({
            code: 'INVALID_SESSION_ID',
        });
        expect(init).not.toHaveBeenCalled();
    });

    it('wraps an adapter failure as STORAGE_ERROR naming the backend and the session', async () => {
        const storage: StorageAdapter = {
            ...memoryStorage(),
            name: 'exploding',
            get: () => Promise.reject(new Error('connection refused')),
        };

        const error = (await useAuthState({ sessionId: SESSION, storage }).catch((e: unknown) => e)) as WhatsMultiError;

        expect(error).toBeInstanceOf(WhatsMultiError);
        expect(error.code).toBe('STORAGE_ERROR');
        expect(error.sessionId).toBe(SESSION);
        expect(error.message).toContain('exploding');
        expect(error.message).toContain('connection refused');
    });

    it('reports which operation failed', async () => {
        const storage: StorageAdapter = {
            ...memoryStorage(),
            name: 'half-broken',
            mget: () => Promise.reject(new Error('timeout')),
        };
        const auth = await useAuthState({ sessionId: SESSION, storage });

        await expect(auth.state.keys.get('pre-key', ['1'])).rejects.toMatchObject({
            code: 'STORAGE_ERROR',
            message: expect.stringContaining('read pre-key') as unknown as string,
        });
    });

    it('calls init once, before any read', async () => {
        const order: string[] = [];
        const inner = memoryStorage();
        const storage: StorageAdapter = {
            ...inner,
            init: () => {
                order.push('init');
                return Promise.resolve();
            },
            get: (key) => {
                order.push('get');
                return inner.get(key);
            },
        };

        await useAuthState({ sessionId: SESSION, storage });

        expect(order).toEqual(['init', 'get']);
    });
});
