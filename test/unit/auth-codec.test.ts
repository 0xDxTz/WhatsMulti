import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';

import { bufferReviver, decodeJson, decodeValue, encodeJson, encodeValue } from '../../src/auth/codec.js';

/**
 * The spec PRNG (spec/algorithms.md section 1). Used here only to make the property
 * test reproducible -- a failing seed is a failing seed on every machine.
 */
function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
        t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
        t = (t ^ (t >>> 14)) >>> 0;
        return t / 4294967296;
    };
}

const ALPHABET = 'aZ09 /+=:%{}"\\é世🚀';

function randomString(rand: () => number, max = 12): string {
    let out = '';
    for (let i = Math.floor(rand() * max); i > 0; i--) {
        out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
    }
    return out;
}

function randomBuffer(rand: () => number, max = 64): Buffer {
    const bytes = Buffer.alloc(Math.floor(rand() * max));
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rand() * 256);
    return bytes;
}

function randomValue(rand: () => number, depth = 0): unknown {
    const pick = Math.floor(rand() * (depth >= 3 ? 6 : 8));
    switch (pick) {
        case 0:
            return null;
        case 1:
            return rand() < 0.5;
        case 2:
            return Math.floor(rand() * 1e9) - 5e8;
        case 3:
            return rand() * 1e6;
        case 4:
            return randomString(rand);
        case 5:
            return randomBuffer(rand);
        case 6:
            return Array.from({ length: Math.floor(rand() * 5) }, () => randomValue(rand, depth + 1));
        default: {
            const out: Record<string, unknown> = {};
            for (let i = Math.floor(rand() * 5); i > 0; i--) {
                out[`k${randomString(rand, 6)}${i}`] = randomValue(rand, depth + 1);
            }
            return out;
        }
    }
}

describe('encodeValue / decodeValue', () => {
    it('round-trips a Buffer byte for byte', () => {
        const original = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]);

        const restored = decodeValue(encodeValue(original)) as Buffer;

        expect(Buffer.isBuffer(restored)).toBe(true);
        expect(restored.equals(original)).toBe(true);
    });

    it('round-trips an empty Buffer', () => {
        const restored = decodeValue(encodeValue(Buffer.alloc(0))) as Buffer;

        expect(Buffer.isBuffer(restored)).toBe(true);
        expect(restored.length).toBe(0);
    });

    it('restores a bare Uint8Array as a Buffer with the same bytes', () => {
        // Buffer is a Uint8Array, and Baileys reads Signal material through
        // Uint8Array-typed fields, so widening on the way back is safe.
        const original = new Uint8Array([1, 2, 3]);

        const restored = decodeValue(encodeValue(original)) as Buffer;

        expect(Buffer.isBuffer(restored)).toBe(true);
        expect([...restored]).toEqual([1, 2, 3]);
    });

    it('reaches Buffers nested in objects and arrays', () => {
        const original = {
            pair: { public: Buffer.from('pub'), private: Buffer.from('priv') },
            list: [Buffer.from('a'), { deep: [Buffer.from('b')] }],
            plain: 'untouched',
        };

        const restored = decodeValue(encodeValue(original)) as typeof original;

        expect(restored.pair.public.toString()).toBe('pub');
        expect(restored.pair.private.toString()).toBe('priv');
        expect((restored.list[0] as Buffer).toString()).toBe('a');
        expect(((restored.list[1] as { deep: Buffer[] }).deep[0] as Buffer).toString()).toBe('b');
        expect(restored.plain).toBe('untouched');
    });

    it('leaves values JSON already handles alone', () => {
        const original = { s: 'x', n: -1.5, b: false, nil: null, arr: [1, 'two', null] };

        expect(decodeValue(encodeValue(original))).toEqual(original);
    });

    it('drops object members JSON cannot represent, as JSON.stringify does', () => {
        const encoded = encodeValue({ keep: 1, gone: undefined, fn: () => 0 });

        expect(encoded).toEqual({ keep: 1 });
    });

    it('encodes a top-level unrepresentable value as null, never as undefined', () => {
        // An adapter deletes through del(); a stored undefined has no meaning and
        // would make mset() ambiguous.
        expect(encodeValue(undefined)).toBeNull();
        expect(encodeValue(() => 0)).toBeNull();
    });

    it('is idempotent, unlike re-running Baileys BufferJSON over its own output', () => {
        const once = encodeValue(Buffer.from('hello'));

        expect(encodeValue(once)).toEqual(once);
        expect((decodeValue(encodeValue(once)) as Buffer).toString()).toBe('hello');
    });

    it('honours toJSON, because the adapter will too', () => {
        const date = new Date('2026-08-18T00:00:00.000Z');

        expect(encodeValue({ at: date })).toEqual({ at: '2026-08-18T00:00:00.000Z' });
    });

    it('treats a hand-written {type:"Buffer"} object as binary', () => {
        // The documented ambiguity of the format, shared with Baileys: the marker
        // shape is reserved, so an application value cannot use it.
        expect((decodeValue({ type: 'Buffer', data: 'aGk=' }) as Buffer).toString()).toBe('hi');
    });

    it('survives arbitrary generated structures', () => {
        const rand = mulberry32(0x5eed);

        for (let i = 0; i < 500; i++) {
            const original = randomValue(rand);
            const restored = decodeValue(encodeValue(original));

            expect(restored, `seed 0x5eed, iteration ${i}`).toEqual(original);
        }
    });
});

describe('BufferJSON compatibility', () => {
    const samples: [string, unknown][] = [
        ['buffer', Buffer.from([0, 1, 250])],
        ['uint8array', new Uint8Array([9, 8, 7])],
        ['empty buffer', Buffer.alloc(0)],
        ['nested', { a: [Buffer.from('x')], b: { c: Buffer.from('y') } }],
        ['no binary', { a: 1, b: 'two', c: [null, true] }],
        ['real creds', initAuthCreds()],
    ];

    it.each(samples)('encodes %s byte-identically to BufferJSON', (_name, value) => {
        expect(encodeJson(value)).toBe(JSON.stringify(value, BufferJSON.replacer));
    });

    it.each(samples)('reads back what BufferJSON wrote for %s', (_name, value) => {
        const written = JSON.stringify(value, BufferJSON.replacer);

        expect(decodeJson(written)).toEqual(JSON.parse(written, BufferJSON.reviver) as unknown);
    });

    it('produces output BufferJSON itself can read', () => {
        const creds = initAuthCreds();

        const restored = JSON.parse(encodeJson(creds), BufferJSON.reviver) as typeof creds;

        expect(Buffer.from(restored.noiseKey.public).equals(Buffer.from(creds.noiseKey.public))).toBe(true);
        expect(restored.registrationId).toBe(creds.registrationId);
    });

    it('round-trips real Baileys credentials without loss', () => {
        const creds = initAuthCreds();

        const restored = decodeValue(encodeValue(creds)) as typeof creds;

        expect(
            Buffer.from(restored.signedIdentityKey.private).equals(Buffer.from(creds.signedIdentityKey.private))
        ).toBe(true);
        expect(restored.signedPreKey.keyId).toBe(creds.signedPreKey.keyId);
        expect(restored.advSecretKey).toBe(creds.advSecretKey);
    });
});

describe('bufferReviver', () => {
    it('ignores anything that is not the marker shape', () => {
        expect(bufferReviver('k', { type: 'Buffer', data: [1, 2] })).toEqual({ type: 'Buffer', data: [1, 2] });
        expect(bufferReviver('k', { type: 'Other', data: 'aGk=' })).toEqual({ type: 'Other', data: 'aGk=' });
        expect(bufferReviver('k', 'plain')).toBe('plain');
    });
});

describe('encodeJson', () => {
    it('renders an unrepresentable value as the JSON text "null"', () => {
        expect(encodeJson(undefined)).toBe('null');
        expect(decodeJson(encodeJson(undefined))).toBeNull();
    });
});
