/**
 * Which sessions exist, and what each one is.
 *
 * Metadata lives under the reserved `meta` key alongside the credentials, so a
 * session is discoverable the moment it is created rather than only once it has
 * paired and written credentials. Its shape matches the `whatsmulti_session` table in
 * spec/storage-schema.sql, which is what lets a Go instance and a TypeScript instance
 * share one database.
 *
 * v1 had no registry: it rebuilt the session list by scanning the filesystem, and its
 * Mongo equivalent filtered with an async predicate inside `.filter()`, so the
 * predicate was always a truthy Promise and nothing was ever filtered out.
 */
import { META_KEY } from '../auth/keys.js';
import { decodeValue, encodeValue } from '../auth/codec.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { namespacePrefix, parseStorageKey, storageKey } from '../storage/namespace.js';

export interface SessionMeta {
    readonly sessionId: string;
    /** Adapter name, for diagnostics. Not enough to rebuild a custom adapter. */
    readonly storage: string;
    /** Unix milliseconds. */
    readonly createdAt: number;
    readonly updatedAt: number;
}

export class SessionRegistry {
    readonly #storage: StorageAdapter;

    constructor(storage: StorageAdapter) {
        this.#storage = storage;
    }

    async read(sessionId: string): Promise<SessionMeta | null> {
        const raw = await this.#storage.get<unknown>(storageKey(sessionId, META_KEY));
        return raw === null ? null : (decodeValue(raw) as SessionMeta);
    }

    async write(meta: SessionMeta): Promise<void> {
        await this.#storage.set(storageKey(meta.sessionId, META_KEY), encodeValue(meta));
    }

    async remove(sessionId: string): Promise<void> {
        await this.#storage.del([storageKey(sessionId, META_KEY)]);
    }

    /**
     * Every session id this adapter holds, in sorted order.
     *
     * Derived from the key namespace rather than from a separate index, so a session
     * cannot exist in storage and be missing from the list. Sessions created against
     * an overriding adapter live in *that* adapter and are not listed here -- the
     * caller supplied the adapter, so the caller re-supplies it.
     */
    async list(): Promise<string[]> {
        const keys = await this.#storage.keys(namespacePrefix());
        const ids = new Set<string>();

        for (const key of keys) {
            const parsed = parseStorageKey(key);
            if (parsed !== null) ids.add(parsed.sessionId);
        }

        return [...ids].sort();
    }
}
