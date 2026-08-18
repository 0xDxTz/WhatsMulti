// Code generated from spec/disconnect-causes.yaml by scripts/generate.mjs. DO NOT EDIT.
// Spec version: 0.2.0

export const DISCONNECT_CAUSES = [
    'restart_required',
    'connection_closed',
    'connection_lost',
    'timed_out',
    'service_unavailable',
    'server_error',
    'connection_replaced',
    'logged_out',
    'bad_session',
    'multidevice_mismatch',
    'device_removed',
    'banned',
    'temporary_ban',
    'client_outdated',
    'bad_user_agent',
    'unknown',
] as const;

export type DisconnectCause =
    | 'restart_required'
    | 'connection_closed'
    | 'connection_lost'
    | 'timed_out'
    | 'service_unavailable'
    | 'server_error'
    | 'connection_replaced'
    | 'logged_out'
    | 'bad_session'
    | 'multidevice_mismatch'
    | 'device_removed'
    | 'banned'
    | 'temporary_ban'
    | 'client_outdated'
    | 'bad_user_agent'
    | 'unknown';

export type DisconnectAction =
    | 'reconnect_backoff'
    | 'reconnect_immediate'
    | 'terminal';

export const DISCONNECT_ACTIONS: Readonly<Record<DisconnectCause, DisconnectAction>> = {
    restart_required: 'reconnect_immediate',
    connection_closed: 'reconnect_backoff',
    connection_lost: 'reconnect_backoff',
    timed_out: 'reconnect_backoff',
    service_unavailable: 'reconnect_backoff',
    server_error: 'reconnect_backoff',
    connection_replaced: 'terminal',
    logged_out: 'terminal',
    bad_session: 'terminal',
    multidevice_mismatch: 'terminal',
    device_removed: 'terminal',
    banned: 'terminal',
    temporary_ban: 'terminal',
    client_outdated: 'terminal',
    bad_user_agent: 'terminal',
    unknown: 'reconnect_backoff',
};

/** Causes whose handling deletes the stored auth state. */
export const PURGES_CREDS: Readonly<Record<DisconnectCause, boolean>> = {
    restart_required: false,
    connection_closed: false,
    connection_lost: false,
    timed_out: false,
    service_unavailable: false,
    server_error: false,
    connection_replaced: false,
    logged_out: true,
    bad_session: true,
    multidevice_mismatch: true,
    device_removed: true,
    banned: true,
    temporary_ban: false,
    client_outdated: false,
    bad_user_agent: false,
    unknown: false,
};

/**
 * Baileys numeric status -> canonical cause. Single-valued by construction; see the
 * collision notes in spec/disconnect-causes.yaml.
 */
export const BAILEYS_STATUS_TO_CAUSE: Readonly<Record<number, DisconnectCause>> = {
    '401': 'logged_out',
    '403': 'device_removed',
    '408': 'timed_out',
    '411': 'multidevice_mismatch',
    '428': 'connection_closed',
    '440': 'connection_replaced',
    '500': 'server_error',
    '503': 'service_unavailable',
    '515': 'restart_required',
};

/** Checked before the numeric map. Matching is case-insensitive substring. */
export const BAILEYS_MESSAGE_TO_CAUSE: readonly (readonly [string, DisconnectCause])[] = [
    ['bad session', 'bad_session'],
];
