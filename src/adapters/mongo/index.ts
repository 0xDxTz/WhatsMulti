/**
 * MongoDB storage and locking.
 *
 * One collection holds every session, keyed by the full storage key. v1 created a
 * collection *and* a global Mongoose model per session id, which collides on name and
 * leaks at scale; it also issued one query per Signal key, so a single resume cost
 * tens of round trips.
 *
 * The database is taken as an argument and never opened here. Connection pooling,
 * replica-set topology and credentials belong to the application, and a client this
 * module opened would also be one it had to decide when to close.
 */
import { randomBytes } from 'node:crypto';

import { WhatsMultiError, describeError } from '../../errors.js';
import type { LockProvider, LockToken } from '../../lock.js';
import type { StorageAdapter } from '../../storage/adapter.js';
import { parseStorageKey } from '../../storage/namespace.js';

/**
 * The slice of the driver this needs, declared structurally.
 *
 * `collection()` is typed as returning `unknown` and cast internally: the driver's own
 * `Collection` carries a dozen overloads per method, and matching them would pin this
 * module to one major version of `mongodb` for no benefit.
 */
export interface MongoDatabase {
    collection(name: string): unknown;
}

interface Filter {
    readonly [field: string]: unknown;
}

interface MongoCollection<T> {
    findOne(filter: Filter, options?: object): Promise<T | null>;
    find(filter: Filter, options?: object): { toArray(): Promise<T[]> };
    insertOne(doc: T): Promise<unknown>;
    updateOne(filter: Filter, update: object, options?: object): Promise<unknown>;
    deleteOne(filter: Filter): Promise<unknown>;
    deleteMany(filter: Filter): Promise<unknown>;
    bulkWrite(operations: object[], options?: object): Promise<unknown>;
    createIndex(spec: object, options?: object): Promise<unknown>;
}

export interface MongoAdapterOptions {
    readonly db: MongoDatabase;
    readonly collection?: string | undefined;
    readonly name?: string | undefined;
}

const AUTH_COLLECTION = 'whatsmulti_auth';
const LOCK_COLLECTION = 'whatsmulti_lock';

/** Anchored, so the prefix scan uses the `_id` index instead of a collection scan. */
function prefixFilter(prefix: string): Filter {
    return { _id: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } };
}

// ---------------------------------------------------------------------- storage

interface AuthDoc {
    _id: string;
    sessionId: string;
    /**
     * JSON text, not a BSON subdocument. BSON would coerce -- a large integer becomes
     * a double, an empty object round-trips as one -- and the contract says a value
     * comes back exactly as it went in.
     */
    value: string;
    updatedAt: number;
}

export function mongoStorage(options: MongoAdapterOptions): StorageAdapter {
    const name = options.name ?? 'mongo';
    const docs = options.db.collection(options.collection ?? AUTH_COLLECTION) as MongoCollection<AuthDoc>;
    let ready: Promise<void> | undefined;

    const guard = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
        try {
            return await run();
        } catch (cause) {
            throw new WhatsMultiError('STORAGE_ERROR', {
                params: { adapter: name, detail: `${operation}: ${describeError(cause)}` },
                cause,
            });
        }
    };

    const doc = (key: string, value: unknown): AuthDoc | null => {
        const parsed = parseStorageKey(key);
        if (parsed === null) return null;
        return { _id: key, sessionId: parsed.sessionId, value: JSON.stringify(value ?? null), updatedAt: Date.now() };
    };

    return {
        name,

        async init() {
            // Only the secondary index: `_id` is indexed by MongoDB itself, and it is
            // what every read here goes through.
            ready ??= guard('init', async () => {
                await docs.createIndex({ sessionId: 1 });
            });
            await ready;
        },

        async get<T>(key: string) {
            return guard('get', async () => {
                const found = await docs.findOne({ _id: key });
                return found === null ? null : (JSON.parse(found.value) as T);
            });
        },

        async mget<T>(keys: string[]) {
            if (keys.length === 0) return [];

            return guard('mget', async () => {
                // One query for the whole batch. Baileys asks for thirty or more keys
                // per resume, and v1 paid a round trip for each.
                const found = await docs.find({ _id: { $in: keys } }).toArray();
                const byKey = new Map(found.map((entry) => [entry._id, entry.value]));

                return keys.map((key) => {
                    const raw = byKey.get(key);
                    return raw === undefined ? null : (JSON.parse(raw) as T);
                });
            });
        },

        async set(key: string, value: unknown) {
            const next = doc(key, value);
            if (next === null) return;

            // `_id` is deliberately left out of the update: MongoDB rejects a $set
            // that touches it, even when the value is the one already there.
            await guard('set', () =>
                docs.updateOne(
                    { _id: key },
                    { $set: { sessionId: next.sessionId, value: next.value, updatedAt: next.updatedAt } },
                    { upsert: true }
                )
            );
        },

        async mset(entries) {
            const operations = entries
                .map(([key, value]) => doc(key, value))
                .filter((next) => next !== null)
                .map((next) => ({
                    updateOne: {
                        filter: { _id: next._id },
                        update: { $set: { sessionId: next.sessionId, value: next.value, updatedAt: next.updatedAt } },
                        upsert: true,
                    },
                }));
            if (operations.length === 0) return;

            // Unordered: the writes are to distinct keys, so one failure should not
            // abandon the rest of a session's state.
            await guard('mset', () => docs.bulkWrite(operations, { ordered: false }));
        },

        async del(keys: string[]) {
            if (keys.length === 0) return;
            await guard('del', () => docs.deleteMany({ _id: { $in: keys } }));
        },

        async keys(prefix: string) {
            return guard('keys', async () => {
                const found = await docs.find(prefixFilter(prefix), { projection: { _id: 1 } }).toArray();
                return found.map((entry) => entry._id);
            });
        },

        async clear(prefix: string) {
            await guard('clear', () => docs.deleteMany(prefixFilter(prefix)));
        },
    };
}

// ------------------------------------------------------------------------- lock

interface LockDoc {
    _id: string;
    token: string;
    owner: string;
    expiresAt: number;
}

/** MongoDB's duplicate-key code. The one error acquire is allowed to interpret. */
const DUPLICATE_KEY = 11000;

function isDuplicateKey(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    return code === DUPLICATE_KEY || (typeof code === 'string' && code === String(DUPLICATE_KEY));
}

export function mongoLock(options: MongoAdapterOptions): LockProvider {
    const name = options.name ?? 'mongo';
    const docs = options.db.collection(options.collection ?? LOCK_COLLECTION) as MongoCollection<LockDoc>;

    const guard = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
        try {
            return await run();
        } catch (cause) {
            throw new WhatsMultiError('STORAGE_ERROR', {
                params: { adapter: name, detail: `${operation}: ${describeError(cause)}` },
                cause,
            });
        }
    };

    const toToken = (found: LockDoc): LockToken => ({
        key: found._id,
        token: found.token,
        owner: found.owner,
        expiresAt: found.expiresAt,
    });

    /** Held iff `expiresAt >= now`, the boundary spec/storage-schema.sql uses. */
    const live = async (key: string, now: number): Promise<LockToken | null> => {
        const found = await docs.findOne({ _id: key });
        if (found === null) return null;
        const token = toToken(found);
        return token.expiresAt >= now ? token : null;
    };

    return {
        name,

        async acquire(key, ttlMs, owner) {
            const now = Date.now();
            const held: LockToken = { key, token: randomBytes(16).toString('hex'), owner, expiresAt: now + ttlMs };

            try {
                // One statement covers all three cases. No document: the filter matches
                // nothing and the upsert inserts. Lapsed document: the filter matches
                // and it is overwritten. Live document: the filter misses, the upsert
                // tries to insert, and the _id index refuses it -- which is the atomic
                // gate that makes exactly one of two racing instances win.
                await guard('acquire', () =>
                    docs.updateOne(
                        { _id: key, expiresAt: { $lt: now } },
                        { $set: { token: held.token, owner, expiresAt: held.expiresAt } },
                        { upsert: true }
                    )
                );
            } catch (cause) {
                const duplicate = isDuplicateKey(cause) || isDuplicateKey((cause as { cause?: unknown })?.cause);
                if (duplicate) return null;
                throw cause;
            }

            return held;
        },

        async renew(token, ttlMs) {
            return guard('renew', async () => {
                const now = Date.now();
                const expiresAt = now + ttlMs;

                await docs.updateOne(
                    { _id: token.key, token: token.token, expiresAt: { $gte: now } },
                    { $set: { expiresAt } }
                );

                // Re-read rather than trusting a modified count, which is 0 both for a
                // filter that missed and for an update that changed nothing.
                const current = await live(token.key, now);
                return current?.token === token.token ? current : null;
            });
        },

        async release(token) {
            await guard('release', () => docs.deleteOne({ _id: token.key, token: token.token }));
        },

        async inspect(key) {
            return guard('inspect', () => live(key, Date.now()));
        },
    };
}
