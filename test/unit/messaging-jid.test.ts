import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
    DEFAULT_SERVER,
    KNOWN_SERVERS,
    isJid,
    isKnownServer,
    normalizeJid,
    normalizePhoneNumber,
    parseJid,
} from '../../src/messaging/jid.js';

const vectors = JSON.parse(readFileSync('spec/vectors/jid.json', 'utf8')) as {
    knownServers: string[];
    cases: { input: string; jid?: string; error?: string }[];
};

const ok = vectors.cases.filter((c) => c.jid !== undefined);
const bad = vectors.cases.filter((c) => c.error !== undefined);

describe('normalizeJid against spec/vectors/jid.json', () => {
    it.each(ok)('$input -> $jid', ({ input, jid }) => {
        expect(normalizeJid(input)).toBe(jid);
    });

    it.each(bad)('$input fails with $error', ({ input, error }) => {
        expect(() => normalizeJid(input)).toThrow(expect.objectContaining({ code: error }) as Error);
    });

    it('agrees with the spec on which servers exist', () => {
        expect([...KNOWN_SERVERS]).toEqual(vectors.knownServers);
    });
});

describe('normalizePhoneNumber', () => {
    it('strips everything that is not a digit', () => {
        expect(normalizePhoneNumber('+62 812-3456-789')).toBe('628123456789');
        expect(normalizePhoneNumber('+1 (555) 010-9999')).toBe('15550109999');
    });

    it('rejects a national-format number', () => {
        // Accepted by any regex you would write for it, and then silently fails to
        // pair. Both rules mirror whatsmeow PairPhone exactly.
        expect(() => normalizePhoneNumber('0812345678')).toThrow(
            expect.objectContaining({ code: 'INVALID_PHONE_NUMBER' }) as Error
        );
    });

    it('rejects a number of six digits or fewer', () => {
        expect(() => normalizePhoneNumber('123456')).toThrow(
            expect.objectContaining({ code: 'INVALID_PHONE_NUMBER' }) as Error
        );
        expect(normalizePhoneNumber('1234567')).toBe('1234567');
    });

    it('explains which rule failed', () => {
        expect(() => normalizePhoneNumber('12345')).toThrow(/5 digits/);
        expect(() => normalizePhoneNumber('0123456789')).toThrow(/national format/);
    });
});

describe('parseJid', () => {
    it('lowercases the server', () => {
        expect(parseJid('628@S.WhatsApp.Net')).toEqual({ user: '628', server: 's.whatsapp.net' });
    });

    it('reports the device suffix it stripped', () => {
        // Addressing a message to one device would deliver it to that device alone.
        expect(parseJid('628123456789:12@s.whatsapp.net')).toEqual({
            user: '628123456789',
            server: 's.whatsapp.net',
            device: '12',
        });
    });

    it('returns null rather than throwing, for callers that are only probing', () => {
        expect(parseJid('628123456789')).toBeNull();
        expect(parseJid('628@example.com')).toBeNull();
        expect(parseJid('@s.whatsapp.net')).toBeNull();
        expect(parseJid(':5@s.whatsapp.net')).toBeNull();
    });

    it.each(KNOWN_SERVERS)('accepts the %s server', (server) => {
        expect(parseJid(`user@${server}`)?.server).toBe(server);
    });
});

describe('isJid / isKnownServer', () => {
    it('distinguishes a JID from a phone number', () => {
        expect(isJid('628123456789@s.whatsapp.net')).toBe(true);
        expect(isJid('628123456789')).toBe(false);
    });

    it('knows the default server', () => {
        expect(DEFAULT_SERVER).toBe('s.whatsapp.net');
        expect(isKnownServer(DEFAULT_SERVER)).toBe(true);
        expect(isKnownServer('example.com')).toBe(false);
    });
});

describe('normalizeJid', () => {
    it('treats anything containing @ as a JID, malformed or not', () => {
        // Falling back to phone parsing would turn 628@example.com into a message
        // addressed to a completely different, valid-looking JID.
        expect(() => normalizeJid('628123456789@example.com')).toThrow(
            expect.objectContaining({ code: 'INVALID_JID' }) as Error
        );
    });

    it('is idempotent', () => {
        const once = normalizeJid('+62 812-3456-789');

        expect(normalizeJid(once)).toBe(once);
    });
});
