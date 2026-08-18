/**
 * One auth state for every storage backend.
 *
 * v1 shipped three of these -- use-local-auth-state, use-memory-auth-state and
 * use-mongo-auth-state -- around 200 lines that were the same logic three times, with
 * the bugs fixed in one copy and not the others. Because a StorageAdapter is a plain
 * key-value store, none of that logic is backend-specific, so there is exactly one
 * implementation here and a new backend inherits it for free. The three key types
 * Baileys v7 added -- lid-mapping, device-list, tctoken -- needed no change to this
 * file either.
 */
import { assertValidSessionId } from '../config.js';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap, SignalKeyType } from '../compat/baileys.js';
import { loadDriver, type BaileysModule } from '../compat/driver.js';
import { describeError, wrapError } from '../errors.js';
import { silentLogger, type Logger } from '../logger.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { parseStorageKey, sessionPrefix, storageKey } from '../storage/namespace.js';

import { decodeValue, encodeValue } from './codec.js';
import { CREDS_KEY, META_KEY, parseSignalKey, signalKey } from './keys.js';

export interface AuthStateOptions {
    readonly sessionId: string;
    readonly storage: StorageAdapter;
    readonly logger?: Logger | undefined;
}

export interface AuthStateHandle {
    readonly sessionId: string;

    /** Hand straight to `makeWASocket({ auth })`. */
    readonly state: AuthenticationState;

    /** Persist the live credentials. Call on every Baileys `creds.update`. */
    saveCreds(): Promise<void>;

    /**
     * Drop every Signal key, keeping credentials and metadata. This is the recovery
     * path for a corrupt key store: the device stays linked and re-syncs.
     */
    clearKeys(): Promise<void>;

    /**
     * Drop everything the session owns. Used when a disconnect cause purges
     * credentials -- a real logout, not a transient failure.
     */
    purge(): Promise<void>;

    getMeta<T>(): Promise<T | null>;
    setMeta(value: unknown): Promise<void>;
}

/**
 * Builds an `AuthenticationState` on top of any StorageAdapter.
 *
 * Loading the driver is what makes this async: `initAuthCreds` generates real
 * Curve25519 material and cannot be reimplemented here, and `AppStateSyncKeyData`
 * timestamps have to be revived as protobuf Longs rather than left as numbers.
 */
export async function useAuthState(options: AuthStateOptions): Promise<AuthStateHandle> {
    const { sessionId, storage } = options;
    assertValidSessionId(sessionId);

    // Silent unless a logger is handed down: this layer has no config of its own,
    // and inventing a level here is how v1 ended up building a logger at import time
    // and never applying the configured one.
    const logger = (options.logger ?? silentLogger).child({ module: 'auth', sessionId });
    const prefix = sessionPrefix(sessionId);
    const key = (name: string) => storageKey(sessionId, name);

    /**
     * Adapters raise backend-native failures and cannot know which session they
     * belong to. Wrapping here attaches both, so a caller sees which session and
     * which backend failed without unwrapping a Mongo or Redis error.
     */
    const guard = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
        try {
            return await run();
        } catch (cause) {
            throw wrapError('STORAGE_ERROR', cause, {
                sessionId,
                params: { adapter: storage.name, detail: `${operation}: ${describeError(cause)}` },
            });
        }
    };

    await guard('init', async () => storage.init?.());

    const driver: BaileysModule = await loadDriver();

    const stored = await guard('read creds', () => storage.get<unknown>(key(CREDS_KEY)));
    const creds = (stored === null ? driver.initAuthCreds() : decodeValue(stored)) as AuthenticationCreds;

    logger.debug({ restored: stored !== null, adapter: storage.name }, 'auth state ready');

    const state: AuthenticationState = {
        creds,
        keys: {
            async get<T extends SignalKeyType>(type: T, ids: string[]) {
                // One round trip for the whole batch. v1 issued a query per id, and
                // Baileys asks for thirty or more while resuming a session.
                const rows = await guard(`read ${type}`, () =>
                    storage.mget<unknown>(ids.map((id) => key(signalKey(type, id))))
                );

                const out: { [id: string]: SignalDataTypeMap[T] } = {};
                ids.forEach((id, index) => {
                    const raw = rows[index];
                    if (raw === null || raw === undefined) return;

                    const value = decodeValue(raw);
                    // The one type that is not plain data: its timestamp has to be a
                    // protobuf Long, and JSON gives back a number.
                    out[id] = (
                        type === 'app-state-sync-key'
                            ? driver.proto.Message.AppStateSyncKeyData.fromObject(value as object)
                            : value
                    ) as SignalDataTypeMap[T];
                });
                return out;
            },

            async set(data) {
                const writes: [string, unknown][] = [];
                const deletes: string[] = [];

                for (const [type, records] of Object.entries(data)) {
                    if (!records) continue;
                    for (const [id, value] of Object.entries(records)) {
                        const full = key(signalKey(type as SignalKeyType, id));
                        if (value === null || value === undefined) deletes.push(full);
                        else writes.push([full, encodeValue(value)]);
                    }
                }

                if (writes.length > 0) await guard('write keys', () => storage.mset(writes));
                if (deletes.length > 0) await guard('delete keys', () => storage.del(deletes));
            },

            async clear() {
                await clearKeys();
            },
        },
    };

    async function clearKeys(): Promise<void> {
        const all = await guard('list keys', () => storage.keys(prefix));
        // Only Signal material: creds and meta are ours, and dropping them here would
        // turn a key-store reset into an unlink.
        const signalKeys = all.filter((full) => {
            const parsed = parseStorageKey(full);
            return parsed !== null && parseSignalKey(parsed.key) !== null;
        });

        if (signalKeys.length === 0) return;
        await guard('delete keys', () => storage.del(signalKeys));
        logger.debug({ count: signalKeys.length }, 'cleared signal keys');
    }

    return {
        sessionId,
        state,

        async saveCreds() {
            await guard('write creds', () => storage.set(key(CREDS_KEY), encodeValue(creds)));
        },

        clearKeys,

        async purge() {
            await guard('clear session', () => storage.clear(prefix));
            logger.debug('purged auth state');
        },

        async getMeta<T>(): Promise<T | null> {
            const raw = await guard('read meta', () => storage.get<unknown>(key(META_KEY)));
            return raw === null ? null : (decodeValue(raw) as T);
        },

        async setMeta(value: unknown) {
            await guard('write meta', () => storage.set(key(META_KEY), encodeValue(value)));
        },
    };
}
