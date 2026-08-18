/**
 * The session state machine, compiled from spec/states.yaml.
 *
 * v1 had no machine: it tracked a bare `status` string and checked it ad hoc, which
 * is why it needed a dedicated commit (d95ef51 "prevent duplicate session start
 * attempts") to patch a race. A transition table makes that race structurally
 * impossible -- `start` simply has no edge out of `connecting`.
 *
 * Illegal moves throw rather than being ignored. A silently dropped transition leaves
 * the machine and the socket disagreeing about reality, and every later decision
 * built on that disagreement is wrong.
 */
import { assertValidSessionId } from '../config.js';
import { WhatsMultiError } from '../errors.js';
import {
    INITIAL_STATE,
    PAIRABLE_STATES,
    SENDABLE_STATES,
    SESSION_STATES,
    TERMINAL_STATES,
    TRANSITIONS,
    type SessionState,
    type SessionTrigger,
} from '../generated/index.js';

export interface Transition {
    readonly from: SessionState;
    readonly to: SessionState;
    readonly trigger: SessionTrigger;
}

/** The lookup behind every method here. Returns null when the move is not allowed. */
export function nextState(from: SessionState, trigger: SessionTrigger): SessionState | null {
    return TRANSITIONS[`${from}:${trigger}`] ?? null;
}

export function isSendable(state: SessionState): boolean {
    return SENDABLE_STATES.includes(state);
}

export function isPairable(state: SessionState): boolean {
    return PAIRABLE_STATES.includes(state);
}

/** `logged_out` only. It is left through `reset`, which is a deliberate re-pairing. */
export function isTerminal(state: SessionState): boolean {
    return TERMINAL_STATES.includes(state);
}

export function isSessionState(value: string): value is SessionState {
    return (SESSION_STATES as readonly string[]).includes(value);
}

export interface SessionMachineOptions {
    readonly sessionId: string;
    readonly initial?: SessionState | undefined;
    /** Called after every accepted transition. Throwing here is the caller's problem. */
    readonly onTransition?: ((transition: Transition) => void) | undefined;
}

export class SessionMachine {
    readonly sessionId: string;

    #state: SessionState;
    readonly #onTransition: ((transition: Transition) => void) | undefined;

    constructor(options: SessionMachineOptions) {
        assertValidSessionId(options.sessionId);
        this.sessionId = options.sessionId;
        this.#state = options.initial ?? INITIAL_STATE;
        this.#onTransition = options.onTransition;
    }

    get state(): SessionState {
        return this.#state;
    }

    is(state: SessionState): boolean {
        return this.#state === state;
    }

    can(trigger: SessionTrigger): boolean {
        return nextState(this.#state, trigger) !== null;
    }

    get sendable(): boolean {
        return isSendable(this.#state);
    }

    get pairable(): boolean {
        return isPairable(this.#state);
    }

    get terminal(): boolean {
        return isTerminal(this.#state);
    }

    /** Applies the trigger, or throws ILLEGAL_TRANSITION naming the move that failed. */
    apply(trigger: SessionTrigger): Transition {
        const to = nextState(this.#state, trigger);
        if (to === null) {
            throw new WhatsMultiError('ILLEGAL_TRANSITION', {
                sessionId: this.sessionId,
                params: { sessionId: this.sessionId, from: this.#state, trigger },
            });
        }

        const transition: Transition = { from: this.#state, to, trigger };
        this.#state = to;
        this.#onTransition?.(transition);
        return transition;
    }

    /**
     * Applies the trigger if it is legal, otherwise returns null.
     *
     * For races the caller genuinely cannot prevent: a driver `close` arriving after
     * the session was already stopped is normal, not a bug, and should not throw.
     */
    tryApply(trigger: SessionTrigger): Transition | null {
        return this.can(trigger) ? this.apply(trigger) : null;
    }
}
