/**
 * The distributed lock that makes a session safe to run in a cluster.
 *
 * Two processes holding one session is not a degraded mode, it is corruption: both
 * write to the same Signal key store, and the loser of that race produces messages
 * nobody can decrypt and a session nobody can resume. So the rule is fail-stop --
 * hold the lock or do not run -- and never split-brain.
 *
 * The row shape is `spec/storage-schema.sql#whatsmulti_lock`, which the Go build
 * writes too. That is what lets a Go instance and a TypeScript instance sharing one
 * database fence each other correctly, even though neither can resume the other's
 * paired sessions.
 *
 * Real backends land in phase 8 (Redis `SET NX PX`, Mongo `findOneAndUpdate` over a
 * TTL index, SQL conditional upsert). This module owns the contract and the
 * single-process implementation.
 */
import { randomBytes } from 'node:crypto';

/** One acquisition. `token` is what proves ownership; `owner` is only for humans. */
export interface LockToken {
    /** `session:<sessionId>`. See `sessionLockKey`. */
    readonly key: string;
    /** Random per acquisition. Renew and release must match on this. */
    readonly token: string;
    /** The acquiring client's `instanceId`. */
    readonly owner: string;
    /** Unix milliseconds. */
    readonly expiresAt: number;
}

export interface LockProvider {
    /** Backend name. Appears in logs. */
    readonly name: string;

    /**
     * Takes the lock, or returns null if someone else holds it. An expired holder is
     * not a holder: every backend evaluates expiry at acquisition time, because a
     * process that died holding a lock cannot release it.
     */
    acquire(key: string, ttlMs: number, owner: string): Promise<LockToken | null>;

    /**
     * Extends the lease, returning the refreshed token, or null if the lock is no
     * longer ours.
     *
     * Returns a token rather than a boolean because the holder's next renew is due
     * relative to the *new* expiry, and a boolean would leave the caller extending a
     * deadline it cannot see.
     */
    renew(token: LockToken, ttlMs: number): Promise<LockToken | null>;

    /**
     * Releases the lock if it is still ours.
     *
     * Must match on `token`, never on `owner` alone: an instance id outlives a single
     * acquisition, so an owner match would let a stale holder release the lock a newer
     * incarnation of itself has since taken.
     */
    release(token: LockToken): Promise<void>;

    /** Who holds it, if anyone. Used to name the owner in a SESSION_LOCKED error. */
    inspect(key: string): Promise<LockToken | null>;

    /** Releases connections and handles. Must be safe to call repeatedly. */
    close?(): Promise<void>;
}

/** `spec/storage-schema.sql#whatsmulti_lock.lock_key`. */
export function sessionLockKey(sessionId: string): string {
    return `session:${sessionId}`;
}

export interface MemoryLockOptions {
    /** Injected in tests, to drive expiry without waiting for it. */
    readonly now?: (() => number) | undefined;
    readonly mintToken?: (() => string) | undefined;
}

/**
 * The single-process provider, and the default.
 *
 * It fences correctly between everything sharing the instance -- pass one to two
 * clients and they contend for real -- and not at all between processes. That is the
 * honest limit of an in-memory lock, and it is why anything running more than one
 * replica needs a backend from phase 8.
 *
 * Deliberately not a module-global store. v1's module-scoped state is exactly the bug
 * this whole rewrite is undoing, and a shared-by-default lock would make two unrelated
 * clients in one process fight over sessions that have nothing to do with each other.
 */
export function memoryLock(options: MemoryLockOptions = {}): LockProvider {
    const now = options.now ?? Date.now;
    const mintToken = options.mintToken ?? (() => randomBytes(16).toString('hex'));
    const locks = new Map<string, LockToken>();

    /** The holder, if the lease has not lapsed. Expired entries are swept on sight. */
    const live = (key: string): LockToken | null => {
        const held = locks.get(key);
        if (held === undefined) return null;
        // `expiresAt >= now`, not `>`: the shared SQL in spec/storage-schema.sql
        // treats a row as stealable only once `expires_at < now`, and a lock that
        // two runtimes disagree about by one millisecond is a lock they can both
        // hold.
        if (held.expiresAt >= now()) return held;
        locks.delete(key);
        return null;
    };

    return {
        name: 'memory',

        acquire(key, ttlMs, owner) {
            if (live(key) !== null) return Promise.resolve(null);

            const held: LockToken = { key, token: mintToken(), owner, expiresAt: now() + ttlMs };
            locks.set(key, held);
            return Promise.resolve(held);
        },

        renew(token, ttlMs) {
            // Checked through `live`, so a lease that lapsed while we were away is a
            // loss even if nobody has taken it yet. Anything else would let a stalled
            // process resume as though it had never stopped proving it was alive.
            if (live(token.key)?.token !== token.token) return Promise.resolve(null);

            const renewed: LockToken = { ...token, expiresAt: now() + ttlMs };
            locks.set(token.key, renewed);
            return Promise.resolve(renewed);
        },

        release(token) {
            if (locks.get(token.key)?.token === token.token) locks.delete(token.key);
            return Promise.resolve();
        },

        inspect(key) {
            return Promise.resolve(live(key));
        },
    };
}
