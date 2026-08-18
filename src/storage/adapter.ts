/**
 * The storage contract.
 *
 * One interface backs every backend, which is what collapses v1's three near-identical
 * auth-state implementations into a single generic one. It is a plain key-value store:
 * adapters never learn what a Signal key is, and never encode anything themselves.
 * That is why the three key types Baileys v7 added -- lid-mapping, device-list,
 * tctoken -- needed no adapter change at all.
 *
 * Every adapter must pass test/conformance/storage.ts. An adapter is finished when
 * that suite is green, including a third-party one.
 */
export interface StorageAdapter {
    /** Backend name. Appears in errors and in the session registry. */
    readonly name: string;

    /** Called once before first use. Must be safe to call repeatedly. */
    init?(): Promise<void>;

    get<T>(key: string): Promise<T | null>;

    /**
     * Required, not optional.
     *
     * Baileys asks for thirty or more Signal keys in one call while resuming a
     * session. v1 issued a round trip per key, so a Mongo-backed session paid tens of
     * queries for a single resume. Returns one entry per requested key, in order,
     * with null for anything missing.
     */
    mget<T>(keys: string[]): Promise<(T | null)[]>;

    set(key: string, value: unknown): Promise<void>;

    mset(entries: readonly (readonly [string, unknown])[]): Promise<void>;

    del(keys: string[]): Promise<void>;

    /**
     * Every key beginning with `prefix`, as full keys. Replaces v1's filesystem
     * scanning, whose Mongo counterpart used an async predicate inside `.filter()`
     * and therefore never filtered anything.
     */
    keys(prefix: string): Promise<string[]>;

    /** Removes everything under `prefix`. Deleting a session is `clear(sessionPrefix(id))`. */
    clear(prefix: string): Promise<void>;

    /** Releases connections and handles. Must be safe to call repeatedly. */
    close?(): Promise<void>;
}

/**
 * Values handed to an adapter are always JSON-serialisable: encoding happens above
 * this layer, in auth/codec. Adapters must round-trip through JSON semantics so that
 * swapping backends cannot change behaviour -- which is also why the in-memory
 * adapter clones rather than storing references.
 */
export type StorageValue = unknown;

/** Accepted wherever a storage backend is configured. */
export type StorageInput = StorageAdapter | 'memory' | 'file';
