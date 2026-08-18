import { describe, expect, it } from 'vitest';

import { memoryStorage } from '../../src/storage/memory.js';
import { storageKey } from '../../src/storage/namespace.js';
import { runStorageConformance } from '../conformance/storage.js';

runStorageConformance('memory', {
    create: () => memoryStorage(),
    reset: (adapter) => adapter.clear('whatsmulti:'),
});

describe('memory backend', () => {
    it('is isolated per instance by default', async () => {
        // v1 kept its in-memory auth state in a module-global Map, so two clients in
        // one process shared sessions without anyone asking for that.
        const first = memoryStorage();
        const second = memoryStorage();

        await first.set(storageKey('a', 'creds'), 1);
        await expect(second.get(storageKey('a', 'creds'))).resolves.toBeNull();
    });

    it('shares a store only when one is passed in', async () => {
        const store = new Map<string, string>();
        const first = memoryStorage({ store });
        const second = memoryStorage({ store });

        await first.set(storageKey('a', 'creds'), 1);
        await expect(second.get(storageKey('a', 'creds'))).resolves.toBe(1);
    });

    it('rejects a value it cannot serialise instead of storing a hole', async () => {
        const adapter = memoryStorage();
        await expect(adapter.set(storageKey('a', 'k'), undefined)).rejects.toThrowError(/not serialisable/);
        await expect(adapter.set(storageKey('a', 'k'), () => 1)).rejects.toThrowError(/not serialisable/);
    });

    it('does not partially apply a batch containing a bad value', async () => {
        const adapter = memoryStorage();
        await expect(
            adapter.mset([
                [storageKey('a', 'good'), 1],
                [storageKey('a', 'bad'), undefined],
            ])
        ).rejects.toThrowError(/not serialisable/);

        await expect(adapter.get(storageKey('a', 'good'))).resolves.toBeNull();
    });
});
