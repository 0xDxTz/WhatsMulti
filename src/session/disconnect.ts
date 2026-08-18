/**
 * What to do about a disconnect.
 *
 * `compat/baileys` answers "which canonical cause is this?"; this module answers
 * "and therefore what happens to the session?". Splitting them is what lets the Go
 * build share the second half unchanged while its driver reports disconnects as typed
 * events rather than numeric codes.
 *
 * Every table consulted here is generated from spec/disconnect-causes.yaml, so the
 * two runtimes cannot drift on the part that matters: whether credentials get
 * deleted.
 *
 * v1 reconnected on exactly one cause (`restartRequired`), had no backoff, and never
 * purged credentials on `loggedOut` -- so a device unlinked from the phone came back
 * as an infinite reconnect loop against credentials that could never work again.
 */
import { resolveDisconnectCause } from '../compat/baileys.js';
import {
    DISCONNECT_ACTIONS,
    PURGES_CREDS,
    type DisconnectAction,
    type DisconnectCause,
    type SessionState,
    type SessionTrigger,
} from '../generated/index.js';

import { nextState } from './state.js';

export interface DisconnectDecision {
    readonly cause: DisconnectCause;
    readonly action: DisconnectAction;
    /** Delete the stored auth state. Only true for causes that cannot be recovered. */
    readonly purgeCreds: boolean;
    /** No reconnect will be attempted, whatever the reconnect config says. */
    readonly terminal: boolean;
}

/** The policy for a cause that has already been resolved -- by either driver. */
export function decisionFor(cause: DisconnectCause): DisconnectDecision {
    const action = DISCONNECT_ACTIONS[cause];
    return { cause, action, purgeCreds: PURGES_CREDS[cause], terminal: action === 'terminal' };
}

/** The policy for a raw Baileys disconnect error. */
export function decideDisconnect(error: unknown): DisconnectDecision {
    return decisionFor(resolveDisconnectCause(error));
}

/**
 * The state-machine trigger a disconnect should be applied with.
 *
 * Depends on the state we are leaving, because `restart_required` is only an edge out
 * of `awaiting_scan` -- that is where it legitimately occurs, right after a scan.
 * Seeing 515 anywhere else means something unexpected happened, and treating it as an
 * ordinary disconnect lets the backoff policy decide rather than forcing an immediate
 * reconnect into a state that did not expect one.
 */
export function disconnectTrigger(cause: DisconnectCause, from: SessionState): SessionTrigger {
    if (PURGES_CREDS[cause]) return 'logged_out';

    if (DISCONNECT_ACTIONS[cause] === 'reconnect_immediate' && nextState(from, 'restart_required') !== null) {
        return 'restart_required';
    }

    return 'disconnected';
}
