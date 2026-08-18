import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readStatusCode, resolveDisconnectCause, RESERVED_KEYS, SIGNAL_KEY_TYPES } from '../../src/compat/baileys.js';
import { DISCONNECT_ACTIONS, PURGES_CREDS, SPEC_VERSION } from '../../src/generated/index.js';

interface MappingRow {
    readonly cause: string;
    readonly action: string;
    readonly purgeCreds: boolean;
}

const vectors = JSON.parse(readFileSync(join(process.cwd(), 'spec', 'vectors', 'disconnect-mapping.json'), 'utf8')) as {
    specVersion: string;
    baileysStatus: (MappingRow & { status: number })[];
    baileysMessage: (MappingRow & { message: string })[];
    baileysUnknown: (MappingRow & { status: number })[];
};

/** A Boom-shaped error, which is how Baileys reports a disconnect. */
const boom = (statusCode: number, message = 'connection closed') =>
    Object.assign(new Error(message), { output: { statusCode } });

describe('spec vectors: disconnect mapping', () => {
    it('runs the vectors for the current spec version', () => {
        expect(vectors.specVersion).toBe(SPEC_VERSION);
    });

    it.each(vectors.baileysStatus)('status $status resolves to $cause', (row) => {
        const cause = resolveDisconnectCause(boom(row.status));
        expect(cause).toBe(row.cause);
        expect(DISCONNECT_ACTIONS[cause]).toBe(row.action);
        expect(PURGES_CREDS[cause]).toBe(row.purgeCreds);
    });

    it.each(vectors.baileysMessage)('message "$message" resolves to $cause', (row) => {
        const cause = resolveDisconnectCause(new Error(row.message));
        expect(cause).toBe(row.cause);
        expect(PURGES_CREDS[cause]).toBe(row.purgeCreds);
    });

    it.each(vectors.baileysUnknown)('unrecognised status $status resolves to $cause', (row) => {
        expect(resolveDisconnectCause(boom(row.status))).toBe(row.cause);
    });
});

describe('resolveDisconnectCause', () => {
    it('reads a bare statusCode as well as a Boom output', () => {
        expect(resolveDisconnectCause({ statusCode: 401 })).toBe('logged_out');
        expect(resolveDisconnectCause(boom(401))).toBe('logged_out');
    });

    it('falls back to unknown for anything unreadable', () => {
        for (const input of [undefined, null, 'nope', 42, {}, new Error('')]) {
            expect(resolveDisconnectCause(input)).toBe('unknown');
        }
    });

    it('never destroys credentials on a transient 500', () => {
        // Baileys assigns 500 to both badSession and a plain server error. Resolving
        // it numerically to bad_session would purge a working session's credentials.
        const cause = resolveDisconnectCause(boom(500, 'Internal Server Error'));
        expect(cause).toBe('server_error');
        expect(PURGES_CREDS[cause]).toBe(false);
        expect(DISCONNECT_ACTIONS[cause]).toBe('reconnect_backoff');
    });

    it('reaches bad_session only when the payload says so', () => {
        const cause = resolveDisconnectCause(boom(500, 'Bad Session detected, please delete and re-scan'));
        expect(cause).toBe('bad_session');
        expect(PURGES_CREDS[cause]).toBe(true);
    });

    it('matches the message case-insensitively', () => {
        expect(resolveDisconnectCause(new Error('BAD SESSION'))).toBe('bad_session');
    });

    it('lets the message win over the numeric map', () => {
        expect(resolveDisconnectCause(boom(428, 'bad session'))).toBe('bad_session');
    });
});

describe('readStatusCode', () => {
    it.each([
        [boom(515), 515],
        [{ statusCode: 408 }, 408],
        [{ output: { statusCode: 'nope' } }, undefined],
        [{ output: null }, undefined],
        ['string', undefined],
        [null, undefined],
    ])('reads %o', (input, expected) => {
        expect(readStatusCode(input)).toBe(expected);
    });
});

describe('signal key types', () => {
    it('covers the full Baileys v7 SignalDataTypeMap', () => {
        // The compile-time `satisfies` in compat/baileys.ts is the real guard; this
        // asserts the three LID-era additions are actually present.
        expect(SIGNAL_KEY_TYPES).toHaveLength(10);
        expect(SIGNAL_KEY_TYPES).toEqual(
            expect.arrayContaining(['lid-mapping', 'device-list', 'tctoken', 'identity-key'])
        );
    });

    it('does not collide with the keys we reserve for ourselves', () => {
        for (const reserved of Object.values(RESERVED_KEYS)) {
            expect(SIGNAL_KEY_TYPES as readonly string[]).not.toContain(reserved);
        }
    });
});
