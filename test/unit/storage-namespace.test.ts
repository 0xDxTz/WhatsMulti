import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SPEC_VERSION } from '../../src/generated/index.js';
import {
    decodeKey,
    encodeKey,
    NAMESPACE,
    namespacePrefix,
    parseStorageKey,
    requireStorageKey,
    sessionPrefix,
    storageKey,
} from '../../src/storage/namespace.js';

const vectors = JSON.parse(readFileSync(join(process.cwd(), 'spec', 'vectors', 'storage-keys.json'), 'utf8')) as {
    specVersion: string;
    signalKeyTypes: string[];
    reservedKeys: string[];
    cases: { sessionId: string; key: string; expected: string; roundTrip: boolean }[];
};

describe('spec vectors: storage keys', () => {
    it('runs the vectors for the current spec version', () => {
        expect(vectors.specVersion).toBe(SPEC_VERSION);
    });

    it.each(vectors.cases)('$sessionId + $key -> $expected', ({ sessionId, key, expected }) => {
        expect(storageKey(sessionId, key)).toBe(expected);
    });

    it.each(vectors.cases)('round-trips $key', ({ sessionId, key, expected }) => {
        expect(parseStorageKey(expected)).toEqual({ sessionId, key });
    });

    it('covers all ten Baileys v7 signal key types', () => {
        expect(vectors.signalKeyTypes).toHaveLength(10);
    });
});

describe('encodeKey', () => {
    it('escapes only the three reserved characters', () => {
        expect(encodeKey('a%b:c/d')).toBe('a%25b%3Ac%2Fd');
        expect(encodeKey('a-b_c.d+e=f@g*h')).toBe('a-b_c.d+e=f@g*h');
    });

    it('is exactly invertible, unlike the v1 scheme', () => {
        // v1 mapped '/' to '__' and ':' to '-', so these two distinct keys became one
        // stored key and one silently overwrote the other.
        expect(encodeKey('pre-key-5')).not.toBe(encodeKey('pre:key:5'));
        expect(decodeKey(encodeKey('pre-key-5'))).toBe('pre-key-5');
        expect(decodeKey(encodeKey('pre:key:5'))).toBe('pre:key:5');
    });

    it.each([
        '',
        'creds',
        'app-state-sync-key-AAAA/BBB+CCC=',
        'sender-key-628@s.whatsapp.net::628999@s.whatsapp.net',
        '100%',
        '%25',
        '::://///',
        'halo dunia 日本語 🔐',
        'x'.repeat(1000),
    ])('round-trips %s', (key) => {
        expect(decodeKey(encodeKey(key))).toBe(key);
    });

    it('leaves a lone percent sign that is not a valid escape intact', () => {
        expect(decodeKey('a%zz')).toBe('a%zz');
        expect(decodeKey('trailing%')).toBe('trailing%');
    });
});

describe('prefixes', () => {
    it('scopes a session', () => {
        expect(sessionPrefix('s1')).toBe('whatsmulti:s1:');
        expect(namespacePrefix()).toBe('whatsmulti:');
        expect(NAMESPACE).toBe('whatsmulti');
    });

    it('makes one session a strict prefix of nothing but itself', () => {
        // Two sessions must not be confusable by prefix, or clear() on one would take
        // the other with it.
        expect(sessionPrefix('s1').startsWith(sessionPrefix('s'))).toBe(false);
        expect(storageKey('s1', 'creds').startsWith(sessionPrefix('s1'))).toBe(true);
        expect(storageKey('s10', 'creds').startsWith(sessionPrefix('s1'))).toBe(false);
    });

    it('places every session under the namespace prefix', () => {
        expect(storageKey('anything', 'creds').startsWith(namespacePrefix())).toBe(true);
    });
});

describe('parseStorageKey', () => {
    it('splits a well-formed key', () => {
        expect(parseStorageKey('whatsmulti:s1:pre-key-1')).toEqual({ sessionId: 's1', key: 'pre-key-1' });
    });

    it('decodes the key half', () => {
        expect(parseStorageKey('whatsmulti:s1:a%3Ab')).toEqual({ sessionId: 's1', key: 'a:b' });
    });

    it.each([
        ['a foreign namespace', 'other:s1:creds'],
        ['no session segment', 'whatsmulti:creds'],
        ['an empty session id', 'whatsmulti::creds'],
        ['no separator at all', 'whatsmulti'],
        ['an empty string', ''],
    ])('returns null for %s', (_label, key) => {
        // Null rather than a throw, so a backend sharing a collection can skip keys
        // that are not ours.
        expect(parseStorageKey(key)).toBeNull();
    });

    it('accepts a key with an empty value half', () => {
        expect(parseStorageKey('whatsmulti:s1:')).toEqual({ sessionId: 's1', key: '' });
    });

    it('requireStorageKey throws where parseStorageKey returns null', () => {
        expect(() => requireStorageKey('other:s1:creds')).toThrowError(/not a WhatsMulti storage key/);
        expect(requireStorageKey('whatsmulti:s1:creds').sessionId).toBe('s1');
    });
});
