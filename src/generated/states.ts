// Code generated from spec/states.yaml by scripts/generate.mjs. DO NOT EDIT.
// Spec version: 0.2.8

export const SESSION_STATES = [
    'idle',
    'connecting',
    'awaiting_scan',
    'open',
    'closing',
    'closed',
    'logged_out',
] as const;

export type SessionState =
    | 'idle'
    | 'connecting'
    | 'awaiting_scan'
    | 'open'
    | 'closing'
    | 'closed'
    | 'logged_out';

export const SESSION_TRIGGERS = [
    'connected',
    'disconnected',
    'fenced',
    'logged_out',
    'qr',
    'qr_exhausted',
    'reconnect',
    'reset',
    'restart_required',
    'start',
    'stop',
    'stopped',
] as const;

export type SessionTrigger =
    | 'connected'
    | 'disconnected'
    | 'fenced'
    | 'logged_out'
    | 'qr'
    | 'qr_exhausted'
    | 'reconnect'
    | 'reset'
    | 'restart_required'
    | 'start'
    | 'stop'
    | 'stopped';

export const INITIAL_STATE: SessionState = 'idle';

export const TERMINAL_STATES: readonly SessionState[] = ['logged_out'];

/** States in which an outbound send is legal. */
export const SENDABLE_STATES: readonly SessionState[] = ['open'];

/** States in which requestPairingCode is legal. */
export const PAIRABLE_STATES: readonly SessionState[] = ['awaiting_scan'];

/** Legal transitions, keyed `from:trigger`. Anything absent is an illegal move. */
export const TRANSITIONS: Readonly<Record<string, SessionState>> = {
    'idle:start': 'connecting',
    'connecting:qr': 'awaiting_scan',
    'connecting:connected': 'open',
    'connecting:stop': 'closing',
    'connecting:disconnected': 'closed',
    'connecting:fenced': 'closed',
    'connecting:logged_out': 'logged_out',
    'awaiting_scan:restart_required': 'connecting',
    'awaiting_scan:connected': 'open',
    'awaiting_scan:qr': 'awaiting_scan',
    'awaiting_scan:stop': 'closing',
    'awaiting_scan:disconnected': 'closed',
    'awaiting_scan:qr_exhausted': 'closed',
    'awaiting_scan:fenced': 'closed',
    'awaiting_scan:logged_out': 'logged_out',
    'open:stop': 'closing',
    'open:disconnected': 'closed',
    'open:fenced': 'closed',
    'open:logged_out': 'logged_out',
    'closing:stopped': 'closed',
    'closed:start': 'connecting',
    'closed:reconnect': 'connecting',
    'closed:logged_out': 'logged_out',
    'logged_out:reset': 'idle',
};
