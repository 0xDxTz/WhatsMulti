import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DISCONNECT_ACTIONS, DISCONNECT_CAUSES, PURGES_CREDS, SESSION_STATES } from '../../src/generated/index.js';
import { decideDisconnect, decisionFor, disconnectTrigger } from '../../src/session/disconnect.js';
import { nextState } from '../../src/session/state.js';

interface VectorCase {
    readonly cause: string;
    readonly action: string;
    readonly purgeCreds: boolean;
}

const vectors = JSON.parse(readFileSync('spec/vectors/disconnect-mapping.json', 'utf8')) as {
    baileysStatus: (VectorCase & { status: number })[];
    baileysMessage: (VectorCase & { message: string })[];
    baileysUnknown: (VectorCase & { status?: number })[];
};

const boom = (status: number) => ({ output: { statusCode: status } });

describe('decideDisconnect against spec/vectors/disconnect-mapping.json', () => {
    it.each(vectors.baileysStatus)('status $status -> $cause / $action', (vector) => {
        const decision = decideDisconnect(boom(vector.status));

        expect(decision.cause).toBe(vector.cause);
        expect(decision.action).toBe(vector.action);
        expect(decision.purgeCreds).toBe(vector.purgeCreds);
        expect(decision.terminal).toBe(vector.action === 'terminal');
    });

    it.each(vectors.baileysMessage)('message "$message" -> $cause', (vector) => {
        const error = Object.assign(new Error(vector.message), { output: { statusCode: 500 } });

        const decision = decideDisconnect(error);

        expect(decision.cause).toBe(vector.cause);
        expect(decision.purgeCreds).toBe(vector.purgeCreds);
    });

    it.each(vectors.baileysUnknown)('unrecognised input -> $cause', (vector) => {
        const decision = decideDisconnect(vector.status === undefined ? new Error('no idea') : boom(vector.status));

        expect(decision.cause).toBe(vector.cause);
        expect(decision.action).toBe(vector.action);
    });

    it('never purges credentials on a plain 500', () => {
        // The collision that matters: Baileys uses 500 for both badSession and an
        // ordinary server error. Purging on the latter deletes a working session.
        const decision = decideDisconnect(boom(500));

        expect(decision.cause).toBe('server_error');
        expect(decision.purgeCreds).toBe(false);
    });
});

describe('decisionFor', () => {
    it.each(DISCONNECT_CAUSES)('matches the generated tables for %s', (cause) => {
        expect(decisionFor(cause)).toEqual({
            cause,
            action: DISCONNECT_ACTIONS[cause],
            purgeCreds: PURGES_CREDS[cause],
            terminal: DISCONNECT_ACTIONS[cause] === 'terminal',
        });
    });

    it('only marks a cause terminal when it purges or explicitly gives up', () => {
        for (const cause of DISCONNECT_CAUSES) {
            if (PURGES_CREDS[cause]) expect(decisionFor(cause).terminal).toBe(true);
        }
    });
});

describe('disconnectTrigger', () => {
    it('sends every credential-purging cause to logged_out', () => {
        for (const cause of DISCONNECT_CAUSES.filter((c) => PURGES_CREDS[c])) {
            expect(disconnectTrigger(cause, 'open')).toBe('logged_out');
        }
    });

    it('restarts in place after a scan', () => {
        // 515 arrives right after pairing, while the session is awaiting_scan, and is
        // the one cause that reconnects without consuming a backoff attempt.
        expect(disconnectTrigger('restart_required', 'awaiting_scan')).toBe('restart_required');
    });

    it('demotes an out-of-place restart to an ordinary disconnect', () => {
        // restart_required has no edge out of `open`. Forcing it would throw; letting
        // backoff handle it is both legal and more conservative.
        expect(disconnectTrigger('restart_required', 'open')).toBe('disconnected');
        expect(nextState('open', 'restart_required')).toBeNull();
    });

    it.each(['connection_closed', 'timed_out', 'server_error', 'unknown'] as const)(
        'uses a plain disconnect for %s',
        (cause) => {
            expect(disconnectTrigger(cause, 'open')).toBe('disconnected');
        }
    );

    it.each(['connection_replaced', 'temporary_ban', 'client_outdated', 'bad_user_agent'] as const)(
        'closes on non-purging terminal cause %s',
        (cause) => {
            // Terminal but recoverable by a human: the session must close without
            // destroying credentials that are still valid.
            expect(disconnectTrigger(cause, 'open')).toBe('disconnected');
            expect(decisionFor(cause).purgeCreds).toBe(false);
        }
    );

    it('produces a trigger for every cause from every state', () => {
        for (const state of SESSION_STATES) {
            for (const cause of DISCONNECT_CAUSES) {
                expect(['logged_out', 'restart_required', 'disconnected']).toContain(disconnectTrigger(cause, state));
            }
        }
    });
});
