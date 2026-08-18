import { describe, expect, it, vi } from 'vitest';

import {
    SessionMachine,
    isPairable,
    isSendable,
    isSessionState,
    isTerminal,
    nextState,
    type Transition,
} from '../../src/session/state.js';
import {
    INITIAL_STATE,
    PAIRABLE_STATES,
    SENDABLE_STATES,
    SESSION_STATES,
    SESSION_TRIGGERS,
    TERMINAL_STATES,
    TRANSITIONS,
    type SessionState,
    type SessionTrigger,
} from '../../src/generated/index.js';

const machine = (initial?: SessionState) =>
    new SessionMachine(initial === undefined ? { sessionId: 's1' } : { sessionId: 's1', initial });

/** Every (state, trigger) pair, split by whether the spec allows it. */
const pairs = SESSION_STATES.flatMap((from) =>
    SESSION_TRIGGERS.map((trigger) => ({ from, trigger, to: TRANSITIONS[`${from}:${trigger}`] ?? null }))
);
const legal = pairs.filter((pair) => pair.to !== null);
const illegal = pairs.filter((pair) => pair.to === null);

describe('nextState', () => {
    it.each(legal)('$from + $trigger -> $to', ({ from, trigger, to }) => {
        expect(nextState(from, trigger)).toBe(to);
    });

    it.each(illegal)('rejects $from + $trigger', ({ from, trigger }) => {
        expect(nextState(from, trigger)).toBeNull();
    });

    it('covers the whole spec table', () => {
        // Guards against the table being read through a stale copy: the counts here
        // come from the generated constants, so adding a transition to the spec
        // without regenerating fails.
        expect(legal).toHaveLength(Object.keys(TRANSITIONS).length);
        expect(illegal.length).toBeGreaterThan(0);
    });
});

describe('state predicates', () => {
    it.each(SESSION_STATES)('classifies %s consistently with the spec', (state) => {
        expect(isSendable(state)).toBe(SENDABLE_STATES.includes(state));
        expect(isPairable(state)).toBe(PAIRABLE_STATES.includes(state));
        expect(isTerminal(state)).toBe(TERMINAL_STATES.includes(state));
        expect(isSessionState(state)).toBe(true);
    });

    it('rejects a string that is not a state', () => {
        expect(isSessionState('online')).toBe(false);
    });

    it('only allows sending while open', () => {
        expect(SENDABLE_STATES).toEqual(['open']);
    });
});

describe('SessionMachine', () => {
    it('starts idle', () => {
        expect(machine().state).toBe(INITIAL_STATE);
        expect(machine().is('idle')).toBe(true);
    });

    it('accepts an explicit initial state, for a session restored from storage', () => {
        expect(machine('open').state).toBe('open');
    });

    it('rejects an invalid session id', () => {
        expect(() => new SessionMachine({ sessionId: 'bad id' })).toThrow(
            expect.objectContaining({ code: 'INVALID_SESSION_ID' }) as Error
        );
    });

    it('walks the pairing path', () => {
        const m = machine();

        expect(m.apply('start')).toEqual({ from: 'idle', to: 'connecting', trigger: 'start' });
        expect(m.apply('qr').to).toBe('awaiting_scan');
        expect(m.apply('connected').to).toBe('open');
        expect(m.sendable).toBe(true);
    });

    it('walks the reconnect path', () => {
        const m = machine('open');

        expect(m.apply('disconnected').to).toBe('closed');
        expect(m.apply('reconnect').to).toBe('connecting');
    });

    it('reports what it can do from the current state', () => {
        const m = machine();

        expect(m.can('start')).toBe(true);
        expect(m.can('connected')).toBe(false);
    });

    it('exposes the pairable window as awaiting_scan only', () => {
        expect(machine('awaiting_scan').pairable).toBe(true);
        expect(machine('connecting').pairable).toBe(false);
        expect(machine('open').pairable).toBe(false);
    });

    it('refuses a second start once connecting', () => {
        // The race v1 needed a patch for: with a table, the edge simply does not
        // exist.
        const m = machine();
        m.apply('start');

        expect(m.can('start')).toBe(false);
        expect(() => m.apply('start')).toThrow(expect.objectContaining({ code: 'ILLEGAL_TRANSITION' }) as Error);
    });

    it('names the failing move in the error', () => {
        const error = (() => {
            try {
                machine('open').apply('start');
            } catch (e: unknown) {
                return e as { message: string; sessionId?: string };
            }
            return null;
        })();

        expect(error?.message).toContain('open');
        expect(error?.message).toContain('start');
        expect(error?.sessionId).toBe('s1');
    });

    it('leaves the state untouched when a transition is rejected', () => {
        const m = machine('open');

        expect(() => m.apply('start')).toThrow();
        expect(m.state).toBe('open');
    });

    it('tryApply swallows an illegal move instead of throwing', () => {
        // A driver `close` arriving after the session was already stopped is normal.
        const m = machine('closed');

        expect(m.tryApply('disconnected')).toBeNull();
        expect(m.state).toBe('closed');
    });

    it('tryApply still performs a legal move', () => {
        const m = machine('closed');

        expect(m.tryApply('start')).toEqual({ from: 'closed', to: 'connecting', trigger: 'start' });
        expect(m.state).toBe('connecting');
    });

    it('treats logged_out as terminal, leaving only through reset', () => {
        const m = machine('open');
        m.apply('logged_out');

        expect(m.terminal).toBe(true);
        expect(m.can('start')).toBe(false);
        expect(m.can('reconnect')).toBe(false);
        expect(m.apply('reset').to).toBe('idle');
    });

    it('reports the transition to the observer, after the state has moved', () => {
        const seen: [Transition, SessionState][] = [];
        const m = new SessionMachine({
            sessionId: 's1',
            onTransition: (transition) => seen.push([transition, m.state]),
        });

        m.apply('start');

        expect(seen).toEqual([[{ from: 'idle', to: 'connecting', trigger: 'start' }, 'connecting']]);
    });

    it('does not notify the observer for a rejected move', () => {
        const onTransition = vi.fn();
        const m = new SessionMachine({ sessionId: 's1', initial: 'open', onTransition });

        expect(() => m.apply('start')).toThrow();
        expect(onTransition).not.toHaveBeenCalled();
    });

    it('works without an observer', () => {
        expect(() => machine().apply('start')).not.toThrow();
    });

    it('reaches every state from idle', () => {
        // Nothing in the table may be unreachable: an orphan state is a spec bug that
        // would show up as a session that can never be stopped or restarted.
        const seen = new Set<SessionState>([INITIAL_STATE]);
        const queue: SessionState[] = [INITIAL_STATE];

        while (queue.length > 0) {
            const from = queue.shift() as SessionState;
            for (const trigger of SESSION_TRIGGERS) {
                const to = nextState(from, trigger as SessionTrigger);
                if (to !== null && !seen.has(to)) {
                    seen.add(to);
                    queue.push(to);
                }
            }
        }

        expect([...seen].sort()).toEqual([...SESSION_STATES].sort());
    });
});
