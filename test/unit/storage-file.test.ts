import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fileStorage } from '../../src/storage/file.js';
import { sessionPrefix, storageKey } from '../../src/storage/namespace.js';
import { runStorageConformance } from '../conformance/storage.js';

const root = await mkdtemp(join(tmpdir(), 'whatsmulti-conf-'));

runStorageConformance('file', {
    create: () => fileStorage({ path: root }),
    reset: (adapter) => adapter.clear('whatsmulti:'),
    teardown: () => rm(root, { recursive: true, force: true }),
});

describe('file backend', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'whatsmulti-file-'));
    });

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    const adapter = () => fileStorage({ path: dir });

    it('lays sessions out one directory deep, so a session is inspectable and removable by hand', async () => {
        const store = adapter();
        await store.set(storageKey('layout', 'creds'), { me: 'x' });

        expect(await readdir(dir)).toContain('layout');
        expect(await readdir(join(dir, 'layout'))).toContain('creds.json');
    });

    it('stores the logical key alongside the value', async () => {
        const store = adapter();
        await store.set(storageKey('envelope', 'pre-key-1'), { k: 1 });

        const raw = JSON.parse(await readFile(join(dir, 'envelope', 'pre-key-1.json'), 'utf8')) as {
            key: string;
            value: unknown;
        };
        expect(raw.key).toBe('pre-key-1');
        expect(raw.value).toEqual({ k: 1 });
    });

    it('escapes characters a filesystem would reject', async () => {
        // Signal key ids are base64 and jids carry '@' and ':'. The namespace layer
        // only escapes ':', '/' and '%', which is enough for a database but not for a
        // filename.
        const store = adapter();
        const key = 'sender-key-628@s.whatsapp.net::628999@s.whatsapp.net';
        await store.set(storageKey('escape', key), 'v');

        const names = await readdir(join(dir, 'escape'));
        expect(names).toHaveLength(1);
        expect(names[0]).not.toContain(':');
        expect(names[0]).not.toContain('@');
        await expect(store.get(storageKey('escape', key))).resolves.toBe('v');
    });

    it('falls back to a digest name for a key too long for a filename', async () => {
        const store = adapter();
        const key = `session-${'x'.repeat(400)}`;
        await store.set(storageKey('long', key), 'v');

        const names = await readdir(join(dir, 'long'));
        expect(names[0]).toMatch(/^~[0-9a-f]{64}\.json$/);
        expect(names[0]!.length).toBeLessThan(255);

        // The name is unrecoverable, so keys() reads the key back out of the envelope.
        await expect(store.keys(sessionPrefix('long'))).resolves.toEqual([storageKey('long', key)]);
        await expect(store.get(storageKey('long', key))).resolves.toBe('v');
    });

    it('writes atomically, so a crash cannot leave truncated credentials', async () => {
        const store = adapter();
        await store.set(storageKey('atomic', 'creds'), { a: 1 });

        // Only the final file is left behind; the temporary is renamed into place.
        const names = await readdir(join(dir, 'atomic'));
        expect(names).toEqual(['creds.json']);
        expect(names.some((n) => n.endsWith('.tmp'))).toBe(false);
    });

    it('ignores a stray temporary file when listing', async () => {
        const store = adapter();
        await store.set(storageKey('stray', 'creds'), 1);
        await writeFile(join(dir, 'stray', 'creds.json.123.abc.tmp'), 'partial');

        await expect(store.keys(sessionPrefix('stray'))).resolves.toEqual([storageKey('stray', 'creds')]);
    });

    it('ignores files it did not write', async () => {
        const store = adapter();
        await store.set(storageKey('foreign', 'creds'), 1);
        await writeFile(join(dir, 'foreign', 'README.txt'), 'not ours');

        await expect(store.keys(sessionPrefix('foreign'))).resolves.toEqual([storageKey('foreign', 'creds')]);
    });

    it('removes the whole directory when a session is cleared', async () => {
        const store = adapter();
        await store.mset([
            [storageKey('doomed', 'creds'), 1],
            [storageKey('doomed', 'pre-key-1'), 2],
        ]);

        await store.clear(sessionPrefix('doomed'));
        expect(await readdir(dir)).not.toContain('doomed');
    });

    it('creates its root lazily and tolerates a missing one', async () => {
        const absent = join(dir, 'nested', 'deeper');
        const store = fileStorage({ path: absent });

        await expect(store.keys('whatsmulti:')).resolves.toEqual([]);
        await store.set(storageKey('made', 'creds'), 1);
        await expect(store.get(storageKey('made', 'creds'))).resolves.toBe(1);
    });

    it('rejects a key that is not namespaced, rather than writing it somewhere odd', async () => {
        await expect(adapter().set('not-a-whatsmulti-key', 1)).rejects.toThrowError(/not a WhatsMulti storage key/);
    });

    it('surfaces a corrupt file as a storage error instead of a silent null', async () => {
        const store = adapter();
        await store.set(storageKey('corrupt', 'creds'), 1);
        await writeFile(join(dir, 'corrupt', 'creds.json'), '{ truncated');

        await expect(store.get(storageKey('corrupt', 'creds'))).rejects.toThrowError(/cannot read/);
    });
});
