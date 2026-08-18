import { describe, expect, it } from 'vitest';

import {
    CREDS_KEY,
    META_KEY,
    RESERVED_KEY_NAMES,
    STORAGE_KEYS,
    isReservedKey,
    isSignalKeyType,
    parseSignalKey,
    signalKey,
} from '../../src/auth/keys.js';
import { SIGNAL_KEY_TYPES, type SignalKeyType } from '../../src/compat/baileys.js';

describe('signalKey', () => {
    it('joins type and id with a hyphen, matching Baileys useMultiFileAuthState', () => {
        expect(signalKey('pre-key', 42)).toBe('pre-key-42');
        expect(signalKey('session', '628123456789.0')).toBe('session-628123456789.0');
    });

    it.each(SIGNAL_KEY_TYPES)('round-trips through parseSignalKey for %s', (type) => {
        expect(parseSignalKey(signalKey(type, 'abc'))).toEqual({ type, id: 'abc' });
    });
});

describe('parseSignalKey', () => {
    it('keeps a hyphenated type intact', () => {
        // v1 used /^(.+?)-(.+)$/, whose lazy group stopped at the first hyphen: this
        // parsed as type "pre", id "key-42", and every type but session and tctoken
        // came out wrong.
        expect(parseSignalKey('pre-key-42')).toEqual({ type: 'pre-key', id: '42' });
        expect(parseSignalKey('app-state-sync-version-critical_block')).toEqual({
            type: 'app-state-sync-version',
            id: 'critical_block',
        });
    });

    it('prefers the longest matching type', () => {
        expect(parseSignalKey('sender-key-memory-628@s.whatsapp.net')).toEqual({
            type: 'sender-key-memory',
            id: '628@s.whatsapp.net',
        });
        expect(parseSignalKey('sender-key-628@g.us::629@s.whatsapp.net')).toEqual({
            type: 'sender-key',
            id: '628@g.us::629@s.whatsapp.net',
        });
    });

    it('keeps ids that themselves contain separators whole', () => {
        const id = 'AAAAAB/c+d=::x-y:z';

        expect(parseSignalKey(signalKey('app-state-sync-key', id))).toEqual({ type: 'app-state-sync-key', id });
    });

    it('returns null for the reserved keys', () => {
        expect(parseSignalKey(CREDS_KEY)).toBeNull();
        expect(parseSignalKey(META_KEY)).toBeNull();
    });

    it('returns null for an unknown type or a missing id', () => {
        expect(parseSignalKey('not-a-type-1')).toBeNull();
        expect(parseSignalKey('pre-key-')).toBeNull();
        expect(parseSignalKey('pre-key')).toBeNull();
        expect(parseSignalKey('')).toBeNull();
    });
});

describe('type guards', () => {
    it.each(SIGNAL_KEY_TYPES)('accepts %s', (type) => {
        expect(isSignalKeyType(type)).toBe(true);
    });

    it('rejects anything else', () => {
        expect(isSignalKeyType('pre')).toBe(false);
        expect(isSignalKeyType(CREDS_KEY)).toBe(false);
    });

    it('knows the reserved names', () => {
        expect(RESERVED_KEY_NAMES).toEqual([CREDS_KEY, META_KEY]);
        expect(isReservedKey(CREDS_KEY)).toBe(true);
        expect(isReservedKey('pre-key-1')).toBe(false);
    });
});

describe('STORAGE_KEYS', () => {
    it('covers every Signal key type', () => {
        // The invariant that keeps a future Baileys key type from being silently
        // unreachable through the named builders.
        const builders = Object.values(STORAGE_KEYS).filter((entry) => typeof entry !== 'string');
        const built = builders.map((build) => parseSignalKey(build('id'))?.type);

        expect(new Set(built)).toEqual(new Set<SignalKeyType>(SIGNAL_KEY_TYPES));
    });

    it('exposes the reserved keys as plain names', () => {
        expect(STORAGE_KEYS.CREDS).toBe('creds');
        expect(STORAGE_KEYS.META).toBe('meta');
    });

    it('builds the v7 key types v1 had no slot for', () => {
        expect(STORAGE_KEYS.LID_MAPPING('628123456789')).toBe('lid-mapping-628123456789');
        expect(STORAGE_KEYS.DEVICE_LIST('628123456789')).toBe('device-list-628123456789');
        expect(STORAGE_KEYS.TCTOKEN('628@s.whatsapp.net')).toBe('tctoken-628@s.whatsapp.net');
    });
});
