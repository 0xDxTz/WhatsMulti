import { WhatsMultiError } from '../errors.js';
import type { StorageAdapter } from './adapter.js';

export interface MemoryStorageOptions {
    /**
     * Share one store between adapters. Off by default: v1 kept its in-memory auth
     * state in a module-global Map, so two clients in one process silently shared
     * sessions.
     */
    readonly store?: Map<string, string> | undefined;
}

/**
 * In-memory backend.
 *
 * Values are held as JSON text rather than as object references. That is not
 * incidental: a reference store would let a caller mutate a value after `set`, and
 * would hand back a live object from `get`, so the conformance suite would pass here
 * for reasons that do not hold for any persistent backend. Serialising keeps it a
 * faithful stand-in.
 */
export function memoryStorage(options: MemoryStorageOptions = {}): StorageAdapter {
    const store = options.store ?? new Map<string, string>();

    const encode = (key: string, value: unknown): string => {
        const json = JSON.stringify(value);
        if (json === undefined) {
            throw new WhatsMultiError('STORAGE_ERROR', {
                params: { adapter: 'memory', detail: `value for "${key}" is not serialisable; use del() to remove` },
            });
        }
        return json;
    };

    const decode = <T>(json: string | undefined): T | null => (json === undefined ? null : (JSON.parse(json) as T));

    return {
        name: 'memory',

        // Declared async even where nothing is awaited: the contract is
        // Promise-returning, and a synchronous throw would reach a caller using
        // .catch() as an uncaught exception instead of a rejection.
        async get<T>(key: string): Promise<T | null> {
            return decode<T>(store.get(key));
        },

        async mget<T>(keys: string[]): Promise<(T | null)[]> {
            return keys.map((key) => decode<T>(store.get(key)));
        },

        async set(key: string, value: unknown): Promise<void> {
            store.set(key, encode(key, value));
        },

        async mset(entries: readonly (readonly [string, unknown])[]): Promise<void> {
            // Encode everything before writing anything, so a bad value in the batch
            // cannot leave the store half-updated.
            const encoded = entries.map(([key, value]) => [key, encode(key, value)] as const);
            for (const [key, json] of encoded) store.set(key, json);
        },

        async del(keys: string[]): Promise<void> {
            for (const key of keys) store.delete(key);
        },

        async keys(prefix: string): Promise<string[]> {
            return [...store.keys()].filter((key) => key.startsWith(prefix));
        },

        async clear(prefix: string): Promise<void> {
            for (const key of [...store.keys()]) {
                if (key.startsWith(prefix)) store.delete(key);
            }
        },
    };
}
