import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { StorageAdapter } from '../../src/storage/adapter.js';
import { decodeKey, sessionPrefix, storageKey } from '../../src/storage/namespace.js';

/**
 * One suite, run against every adapter.
 *
 * This is what makes backends interchangeable rather than merely similar. An adapter
 * -- including a third-party one -- is finished when this is green. Anything asserted
 * here is part of the contract; anything not asserted here is an implementation
 * detail an adapter is free to change.
 */

export interface ConformanceHarness {
    readonly create: () => StorageAdapter | Promise<StorageAdapter>;
    /** Called after each test so cases cannot leak into one another. */
    readonly reset?: (adapter: StorageAdapter) => void | Promise<void>;
    readonly teardown?: (adapter: StorageAdapter) => void | Promise<void>;
}

const vectors = JSON.parse(readFileSync(join(process.cwd(), 'spec', 'vectors', 'storage-keys.json'), 'utf8')) as {
    signalKeyTypes: string[];
    reservedKeys: string[];
    cases: { sessionId: string; key: string; expected: string }[];
};

export function runStorageConformance(name: string, harness: ConformanceHarness): void {
    describe(`storage conformance: ${name}`, () => {
        let adapter: StorageAdapter;

        const A = (key: string) => storageKey('conf-a', key);
        const B = (key: string) => storageKey('conf-b', key);

        beforeAll(async () => {
            adapter = await harness.create();
            await adapter.init?.();
        });

        afterEach(async () => {
            await harness.reset?.(adapter);
        });

        afterAll(async () => {
            await harness.teardown?.(adapter);
            await adapter.close?.();
        });

        it('exposes a non-empty name', () => {
            expect(typeof adapter.name).toBe('string');
            expect(adapter.name.length).toBeGreaterThan(0);
        });

        it('init is safe to call repeatedly', async () => {
            await adapter.init?.();
            await adapter.init?.();
            await expect(adapter.get(A('creds'))).resolves.toBeNull();
        });

        describe('get and set', () => {
            it('returns null for a key that was never written', async () => {
                await expect(adapter.get(A('missing'))).resolves.toBeNull();
            });

            it.each([
                ['a string', 'hello'],
                ['a number', 42],
                ['zero', 0],
                ['a negative number', -1],
                ['a float', 1.5],
                ['true', true],
                ['false', false],
                ['null', null],
                ['an empty object', {}],
                ['an empty array', []],
                ['a nested object', { a: { b: [1, 2, { c: 'd' }] } }],
                ['unicode', { text: 'halo dunia - 日本語 - 🔐' }],
                ['a long string', 'x'.repeat(10_000)],
            ])('round-trips %s', async (_label, value) => {
                await adapter.set(A('value'), value);
                await expect(adapter.get(A('value'))).resolves.toEqual(value);
            });

            it('overwrites an existing value', async () => {
                await adapter.set(A('k'), { v: 1 });
                await adapter.set(A('k'), { v: 2 });
                await expect(adapter.get(A('k'))).resolves.toEqual({ v: 2 });
            });

            it('does not alias the caller value', async () => {
                // A backend that stored the reference would let a later mutation
                // rewrite history, and no persistent backend behaves that way.
                const value: { list: number[] } = { list: [1] };
                await adapter.set(A('alias'), value);
                value.list.push(2);
                await expect(adapter.get(A('alias'))).resolves.toEqual({ list: [1] });
            });

            it('does not alias the returned value', async () => {
                await adapter.set(A('alias2'), { list: [1] });
                const first = await adapter.get<{ list: number[] }>(A('alias2'));
                first?.list.push(99);
                await expect(adapter.get(A('alias2'))).resolves.toEqual({ list: [1] });
            });
        });

        describe('batch access', () => {
            it('returns one entry per key, in order, with null for misses', async () => {
                // Baileys asks for thirty-plus keys per session resume; this is the
                // path v1 turned into one round trip each.
                await adapter.mset([
                    [A('one'), 1],
                    [A('three'), 3],
                ]);

                await expect(adapter.mget([A('one'), A('two'), A('three')])).resolves.toEqual([1, null, 3]);
            });

            it('handles an empty batch', async () => {
                await expect(adapter.mget([])).resolves.toEqual([]);
                await expect(adapter.mset([])).resolves.toBeUndefined();
                await expect(adapter.del([])).resolves.toBeUndefined();
            });

            it('preserves duplicate keys in the request', async () => {
                await adapter.set(A('dup'), 'v');
                await expect(adapter.mget([A('dup'), A('dup')])).resolves.toEqual(['v', 'v']);
            });

            it('writes a large batch', async () => {
                const entries = Array.from({ length: 200 }, (_, i) => [A(`bulk-${i}`), { i }] as const);
                await adapter.mset(entries);

                const read = await adapter.mget<{ i: number }>(entries.map(([key]) => key));
                expect(read).toHaveLength(200);
                expect(read[0]).toEqual({ i: 0 });
                expect(read[199]).toEqual({ i: 199 });
            });
        });

        describe('deletion', () => {
            it('removes a key', async () => {
                await adapter.set(A('gone'), 'v');
                await adapter.del([A('gone')]);
                await expect(adapter.get(A('gone'))).resolves.toBeNull();
            });

            it('is a no-op for a key that does not exist', async () => {
                await expect(adapter.del([A('never-written')])).resolves.toBeUndefined();
            });

            it('removes several keys and leaves the rest', async () => {
                await adapter.mset([
                    [A('d1'), 1],
                    [A('d2'), 2],
                    [A('keep'), 3],
                ]);
                await adapter.del([A('d1'), A('d2')]);

                await expect(adapter.mget([A('d1'), A('d2'), A('keep')])).resolves.toEqual([null, null, 3]);
            });
        });

        describe('listing', () => {
            it('returns full keys under the prefix', async () => {
                await adapter.mset([
                    [A('k1'), 1],
                    [A('k2'), 2],
                ]);

                const keys = await adapter.keys(sessionPrefix('conf-a'));
                expect(keys.sort()).toEqual([A('k1'), A('k2')].sort());
            });

            it('returns an empty list when nothing matches', async () => {
                await expect(adapter.keys(sessionPrefix('no-such-session'))).resolves.toEqual([]);
            });

            it('does not leak keys across sessions', async () => {
                await adapter.mset([
                    [A('mine'), 1],
                    [B('theirs'), 2],
                ]);

                await expect(adapter.keys(sessionPrefix('conf-a'))).resolves.toEqual([A('mine')]);
                await expect(adapter.keys(sessionPrefix('conf-b'))).resolves.toEqual([B('theirs')]);
            });

            it('lists across sessions for a namespace-wide prefix', async () => {
                await adapter.mset([
                    [A('x'), 1],
                    [B('y'), 2],
                ]);

                const keys = await adapter.keys('whatsmulti:');
                expect(keys).toContain(A('x'));
                expect(keys).toContain(B('y'));
            });
        });

        describe('clear', () => {
            it('removes everything for one session and nothing else', async () => {
                await adapter.mset([
                    [A('a1'), 1],
                    [A('a2'), 2],
                    [B('b1'), 3],
                ]);

                await adapter.clear(sessionPrefix('conf-a'));

                await expect(adapter.keys(sessionPrefix('conf-a'))).resolves.toEqual([]);
                await expect(adapter.get(B('b1'))).resolves.toBe(3);
            });

            it('is a no-op for a prefix with no keys', async () => {
                await expect(adapter.clear(sessionPrefix('absent'))).resolves.toBeUndefined();
            });

            it('leaves the session usable afterwards', async () => {
                await adapter.set(A('again'), 1);
                await adapter.clear(sessionPrefix('conf-a'));
                await adapter.set(A('again'), 2);
                await expect(adapter.get(A('again'))).resolves.toBe(2);
            });
        });

        describe('key handling', () => {
            it.each(vectors.cases.map((c) => c.key))('round-trips the key %s', async (key) => {
                const full = storageKey('conf-a', key);
                await adapter.set(full, { key });
                await expect(adapter.get(full)).resolves.toEqual({ key });

                const listed = await adapter.keys(sessionPrefix('conf-a'));
                expect(listed).toContain(full);
                expect(listed.map((k) => decodeKey(k.slice(sessionPrefix('conf-a').length)))).toContain(key);
            });

            it('keeps keys distinct that v1 collapsed together', async () => {
                // v1 escaped '/' to '__' and ':' to '-', which is not invertible:
                // these two keys became the same stored key and one silently won.
                await adapter.set(A('pre-key-5'), 'hyphen');
                await adapter.set(A('pre:key:5'), 'colon');

                await expect(adapter.get(A('pre-key-5'))).resolves.toBe('hyphen');
                await expect(adapter.get(A('pre:key:5'))).resolves.toBe('colon');
            });

            it('stores every Baileys v7 signal key type plus the reserved keys', async () => {
                const keys = [...vectors.signalKeyTypes.map((type) => `${type}-abc/def+ghi=`), ...vectors.reservedKeys];
                await adapter.mset(keys.map((key) => [A(key), { key }] as const));

                const read = await adapter.mget<{ key: string }>(keys.map((key) => A(key)));
                expect(read.map((entry) => entry?.key)).toEqual(keys);
            });

            it('handles a key long enough to break a filesystem name', async () => {
                const key = `session-${'x'.repeat(400)}`;
                await adapter.set(A(key), 'long');
                await expect(adapter.get(A(key))).resolves.toBe('long');
                await expect(adapter.keys(sessionPrefix('conf-a'))).resolves.toContain(A(key));
            });
        });

        describe('concurrency', () => {
            it('survives parallel writes to distinct keys', async () => {
                await Promise.all(Array.from({ length: 50 }, (_, i) => adapter.set(A(`par-${i}`), i)));

                const read = await adapter.mget<number>(Array.from({ length: 50 }, (_, i) => A(`par-${i}`)));
                expect(read).toEqual(Array.from({ length: 50 }, (_, i) => i));
            });

            it('leaves a readable value after parallel writes to one key', async () => {
                await Promise.all(Array.from({ length: 20 }, (_, i) => adapter.set(A('hot'), i)));
                await expect(adapter.get<number>(A('hot'))).resolves.toEqual(expect.any(Number));
            });
        });
    });
}
