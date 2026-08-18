import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { memoryStorage } from '../../src/storage/memory.js';
import { resolveStorage } from '../../src/storage/resolve.js';
import { DEFAULT_STORAGE_PATH } from '../../src/storage/file.js';

describe('resolveStorage', () => {
    it('resolves the memory shorthand', () => {
        expect(resolveStorage('memory').name).toBe('memory');
    });

    it('resolves the file shorthand', () => {
        expect(resolveStorage('file').name).toBe('file');
    });

    it('returns an adapter instance untouched', () => {
        const adapter = memoryStorage();
        expect(resolveStorage(adapter)).toBe(adapter);
    });

    it.each([
        ['an unknown shorthand', 'mongodb'],
        ['null', null],
        ['a number', 7],
        ['an object that is not an adapter', { name: 'fake' }],
    ])('rejects %s', (_label, input) => {
        expect(() => resolveStorage(input as never)).toThrowError(/expected "memory", "file", or a StorageAdapter/);
    });

    it('gives each memory shorthand its own store', async () => {
        const first = resolveStorage('memory');
        const second = resolveStorage('memory');

        await first.set('whatsmulti:a:creds', 1);
        await expect(second.get('whatsmulti:a:creds')).resolves.toBeNull();
    });

    it('exposes the default file path without creating it eagerly', async () => {
        expect(DEFAULT_STORAGE_PATH).toBe('./whatsmulti_sessions');
        // Constructing the adapter must not touch the filesystem; only init() does.
        resolveStorage('file');
        await rm(DEFAULT_STORAGE_PATH, { recursive: true, force: true });
    });
});
