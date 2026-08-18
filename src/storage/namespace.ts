import { WhatsMultiError } from '../errors.js';

/**
 * Storage key layout, normative in spec/algorithms.md section 3 and pinned by
 * spec/vectors/storage-keys.json.
 *
 *     whatsmulti:<sessionId>:<percent-encoded key>
 *
 * One namespace holds every session, so a backend needs one collection, one table or
 * one keyspace. v1 created a Mongo collection *and* a global Mongoose model per
 * session id, which collides on name and leaks at scale.
 */

export const NAMESPACE = 'whatsmulti';
export const SEPARATOR = ':';

/**
 * Only these three need escaping. `%` because it is the escape character, `:`
 * because it separates the segments, and `/` because it is a path separator for the
 * file backend.
 *
 * Session ids cannot contain any of them (spec/config.yaml#session_id.pattern), so
 * only the key half is ever encoded.
 */
const RESERVED = new Set(['%', ':', '/']);

const hex = (byte: number) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * Percent-encoding, chosen because it is exactly invertible. v1 replaced `/` with
 * `__` and `:` with `-`, which is not: `pre-key-5` and `pre:key:5` both collapsed to
 * the same stored key, so one silently overwrote the other.
 */
export function encodeKey(key: string): string {
    let out = '';
    for (const byte of Buffer.from(key, 'utf8')) {
        const char = String.fromCharCode(byte);
        out += RESERVED.has(char) ? hex(byte) : char;
    }
    return out;
}

export function decodeKey(encoded: string): string {
    const bytes: number[] = [];
    for (let i = 0; i < encoded.length; i++) {
        if (encoded[i] === '%' && i + 2 < encoded.length) {
            const parsed = Number.parseInt(encoded.slice(i + 1, i + 3), 16);
            if (!Number.isNaN(parsed)) {
                bytes.push(parsed);
                i += 2;
                continue;
            }
        }
        bytes.push(encoded.charCodeAt(i));
    }
    return Buffer.from(bytes).toString('utf8');
}

/** The prefix covering every key of one session. Pass to `keys()` or `clear()`. */
export function sessionPrefix(sessionId: string): string {
    return `${NAMESPACE}${SEPARATOR}${sessionId}${SEPARATOR}`;
}

/** The prefix covering every session in the namespace. */
export function namespacePrefix(): string {
    return `${NAMESPACE}${SEPARATOR}`;
}

export function storageKey(sessionId: string, key: string): string {
    return sessionPrefix(sessionId) + encodeKey(key);
}

export interface ParsedStorageKey {
    readonly sessionId: string;
    readonly key: string;
}

/**
 * Splits a namespaced key back into its parts. Returns null rather than throwing so
 * a backend can skip foreign keys sharing its collection.
 */
export function parseStorageKey(full: string): ParsedStorageKey | null {
    const first = full.indexOf(SEPARATOR);
    if (first === -1 || full.slice(0, first) !== NAMESPACE) return null;

    const second = full.indexOf(SEPARATOR, first + 1);
    if (second === -1) return null;

    const sessionId = full.slice(first + 1, second);
    if (sessionId.length === 0) return null;

    return { sessionId, key: decodeKey(full.slice(second + 1)) };
}

/** Same, but for backends that cannot proceed without the session id. */
export function requireStorageKey(full: string): ParsedStorageKey {
    const parsed = parseStorageKey(full);
    if (parsed === null) {
        throw new WhatsMultiError('STORAGE_ERROR', {
            params: { adapter: 'namespace', detail: `"${full}" is not a WhatsMulti storage key` },
        });
    }
    return parsed;
}
