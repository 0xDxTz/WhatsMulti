/**
 * Key naming for auth material, normative in spec/algorithms.md section 3.
 *
 *     creds                 the credential blob
 *     meta                  session metadata
 *     <type>-<id>           one Signal key, for each of the ten v7 key types
 *
 * The hyphen form is the one Baileys' own useMultiFileAuthState writes, which is what
 * lets an existing store migrate by re-prefixing rather than by re-pairing.
 */
import { RESERVED_KEYS, SIGNAL_KEY_TYPES, type SignalKeyType } from '../compat/baileys.js';

/** The credential blob. Written on every `creds.update`. */
export const CREDS_KEY = RESERVED_KEYS.creds;

/** Session metadata: storage backend, socket options, timestamps. */
export const META_KEY = RESERVED_KEYS.meta;

/** Keys that are ours rather than Signal's. Never returned by {@link parseSignalKey}. */
export const RESERVED_KEY_NAMES: readonly string[] = [CREDS_KEY, META_KEY];

/**
 * Key types longest first, which is what makes parsing deterministic:
 * `sender-key-memory` has to win over `sender-key`.
 */
const TYPES_BY_LENGTH: readonly SignalKeyType[] = [...SIGNAL_KEY_TYPES].sort((a, b) => b.length - a.length);

export function isSignalKeyType(value: string): value is SignalKeyType {
    return (SIGNAL_KEY_TYPES as readonly string[]).includes(value);
}

export function isReservedKey(value: string): boolean {
    return RESERVED_KEY_NAMES.includes(value);
}

/** The storage key for one Signal entry, before namespacing. */
export function signalKey(type: SignalKeyType, id: string | number): string {
    return `${type}-${String(id)}`;
}

export interface ParsedSignalKey {
    readonly type: SignalKeyType;
    readonly id: string;
}

/**
 * Splits `<type>-<id>` back apart, or returns null for `creds`, `meta` and anything
 * unrecognised.
 *
 * v1 did this with `/^(.+?)-(.+)$/`, whose lazy first group stops at the first
 * hyphen: `pre-key-42` parsed as type `pre`, id `key-42`, and every key type except
 * `session` and `tctoken` parsed wrong. Matching against the known type list instead
 * removes the guesswork.
 *
 * One residual ambiguity is inherent to a flat `<type>-<id>` name: a `sender-key`
 * whose id began with `memory-` would be read as a `sender-key-memory`. Signal ids
 * are JID-derived and start with digits, so it cannot occur in practice -- and
 * changing the separator would break the spec'd layout the Go build shares.
 */
export function parseSignalKey(key: string): ParsedSignalKey | null {
    if (isReservedKey(key)) return null;

    for (const type of TYPES_BY_LENGTH) {
        const prefix = `${type}-`;
        if (key.startsWith(prefix) && key.length > prefix.length) {
            return { type, id: key.slice(prefix.length) };
        }
    }

    return null;
}

/**
 * The named key builders, carried over from v1's src/Storage/StorageKeys.ts so that
 * call sites read the same. They are now derived from SIGNAL_KEY_TYPES rather than
 * hand-listed, so a Baileys release that adds a key type cannot leave one behind.
 */
export const STORAGE_KEYS = {
    CREDS: CREDS_KEY,
    META: META_KEY,
    PRE_KEY: (id: string | number) => signalKey('pre-key', id),
    SESSION_KEY: (id: string | number) => signalKey('session', id),
    SENDER_KEY: (id: string | number) => signalKey('sender-key', id),
    SENDER_KEY_MEMORY: (id: string | number) => signalKey('sender-key-memory', id),
    APP_STATE_SYNC_KEY: (id: string | number) => signalKey('app-state-sync-key', id),
    APP_STATE_SYNC_VERSION: (id: string | number) => signalKey('app-state-sync-version', id),
    LID_MAPPING: (id: string | number) => signalKey('lid-mapping', id),
    DEVICE_LIST: (id: string | number) => signalKey('device-list', id),
    TCTOKEN: (id: string | number) => signalKey('tctoken', id),
    IDENTITY_KEY: (id: string | number) => signalKey('identity-key', id),
} as const;
