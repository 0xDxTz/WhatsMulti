/**
 * The value codec: how a Signal key or a credential blob becomes something a
 * StorageAdapter can hold.
 *
 * Signal material is mostly binary, and JSON has no binary type. Baileys solves this
 * with `BufferJSON`; this module reimplements the same wire shape,
 * `{ type: 'Buffer', data: <base64> }`, for three reasons:
 *
 * - Core stays dependency-free. Encoding a stored value must not require loading the
 *   driver, so a migration script or a storage inspection tool works standalone.
 * - The encoding is ours to keep stable. Baileys is on an RC line; a change to
 *   BufferJSON there must not silently rewrite everyone's on-disk format.
 * - test/unit/auth-codec asserts byte-identical output against the real BufferJSON,
 *   so a store written by Baileys' own useMultiFileAuthState -- or by WhatsMulti v1,
 *   which used BufferJSON directly -- is readable here.
 *
 * Note that the auth format is deliberately *not* part of spec/: whatsmeow owns its
 * own device store, so this is the one layer the Go build does not share (plan
 * section 4.2).
 */

/** The on-disk shape of a binary value. */
export interface EncodedBuffer {
    readonly type: 'Buffer';
    readonly data: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const encodeBuffer = (bytes: Uint8Array | readonly number[]): EncodedBuffer => ({
    type: 'Buffer',
    data: Buffer.from(bytes as Uint8Array).toString('base64'),
});

/**
 * A `JSON.stringify` replacer that turns binary into `EncodedBuffer`.
 *
 * `toJSON` runs before a replacer, so a Buffer never arrives here as a Buffer: it
 * has already become `{ type: 'Buffer', data: [ ...bytes ] }`. A bare Uint8Array has
 * no `toJSON` and does arrive intact. Both cases are handled, which is why the
 * ordering below matters.
 */
export function bufferReplacer(this: unknown, _key: string, value: unknown): unknown {
    if (value instanceof Uint8Array) return encodeBuffer(value);

    if (isRecord(value) && value['type'] === 'Buffer') {
        const data = value['data'];
        // Already encoded. Re-encoding it would base64 the base64 -- which is what
        // Baileys' own replacer does, and the reason a value must never be handed
        // through the codec twice there.
        if (typeof data === 'string') return value;
        if (Array.isArray(data)) return encodeBuffer(data as number[]);
    }

    return value;
}

/**
 * A `JSON.parse` reviver that restores binary. Shallow by design: `JSON.parse`
 * revives depth-first, so by the time an `EncodedBuffer` reaches this function its
 * `data` string is already final.
 */
export function bufferReviver(this: unknown, _key: string, value: unknown): unknown {
    if (isRecord(value) && value['type'] === 'Buffer' && typeof value['data'] === 'string') {
        return Buffer.from(value['data'], 'base64');
    }
    return value;
}

/**
 * Prepares a value for a StorageAdapter, which stores JSON-serialisable values.
 *
 * Implemented as a stringify/parse round trip rather than a hand-written walk. The
 * adapter is going to apply `JSON.stringify` semantics anyway -- `toJSON` hooks,
 * dropped `undefined` and function members, Date to ISO string, circular detection --
 * so borrowing them here is what guarantees the encoded value survives the adapter
 * unchanged. A hand-rolled walk is where that divergence would hide.
 *
 * A value JSON cannot represent at all (`undefined`, a function, a symbol) encodes to
 * `null`: an adapter takes deletion through `del`, never through a stored undefined.
 */
export function encodeValue(value: unknown): unknown {
    const json = JSON.stringify(value, bufferReplacer);
    return json === undefined ? null : (JSON.parse(json) as unknown);
}

/**
 * Restores a value read back from a StorageAdapter.
 *
 * Recursive rather than a parse round trip, because the input is already plain JSON.
 *
 * Baileys' reviver carries one extra rule this does not: an object whose keys are all
 * numeric and whose values are all numbers is treated as a Buffer. That predates the
 * `{ type: 'Buffer' }` shape and can only fire on data no conforming writer produces,
 * while it can silently turn a legitimate `{ "0": 1 }` map into binary. It is left
 * out on purpose.
 */
export function decodeValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(decodeValue);

    if (isRecord(value)) {
        if (value['type'] === 'Buffer' && typeof value['data'] === 'string') {
            return Buffer.from(value['data'], 'base64');
        }
        const out: Record<string, unknown> = {};
        for (const [key, nested] of Object.entries(value)) out[key] = decodeValue(nested);
        return out;
    }

    return value;
}

/** Encoded form as JSON text. Used by migration tooling and by the format tests. */
export function encodeJson(value: unknown): string {
    return JSON.stringify(value, bufferReplacer) ?? 'null';
}

/** Inverse of {@link encodeJson}. */
export function decodeJson(json: string): unknown {
    return JSON.parse(json, bufferReviver) as unknown;
}
