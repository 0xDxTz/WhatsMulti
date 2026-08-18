// Code generated from spec/errors.yaml by scripts/generate.mjs. DO NOT EDIT.
// Spec version: 0.2.10

export const ERROR_CODES = [
    'SESSION_NOT_FOUND',
    'SESSION_EXISTS',
    'INVALID_SESSION_ID',
    'SESSION_NOT_READY',
    'SESSION_LOCKED',
    'SESSION_LOGGED_OUT',
    'SESSION_FAILED',
    'STORAGE_ERROR',
    'SEND_FAILED',
    'LOGOUT_FAILED',
    'MEDIA_DOWNLOAD_FAILED',
    'TIMEOUT',
    'MISSING_PEER',
    'INVALID_CONFIG',
    'CLIENT_DESTROYED',
    'PAIRING_UNAVAILABLE',
    'PAIRING_IN_PROGRESS',
    'INVALID_PHONE_NUMBER',
    'INVALID_JID',
    'LISTENER_FAILED',
    'ILLEGAL_TRANSITION',
] as const;

export type ErrorCode =
    | 'SESSION_NOT_FOUND'
    | 'SESSION_EXISTS'
    | 'INVALID_SESSION_ID'
    | 'SESSION_NOT_READY'
    | 'SESSION_LOCKED'
    | 'SESSION_LOGGED_OUT'
    | 'SESSION_FAILED'
    | 'STORAGE_ERROR'
    | 'SEND_FAILED'
    | 'LOGOUT_FAILED'
    | 'MEDIA_DOWNLOAD_FAILED'
    | 'TIMEOUT'
    | 'MISSING_PEER'
    | 'INVALID_CONFIG'
    | 'CLIENT_DESTROYED'
    | 'PAIRING_UNAVAILABLE'
    | 'PAIRING_IN_PROGRESS'
    | 'INVALID_PHONE_NUMBER'
    | 'INVALID_JID'
    | 'LISTENER_FAILED'
    | 'ILLEGAL_TRANSITION';

/** Message templates. `{placeholder}` slots are filled by the error constructor. */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
    SESSION_NOT_FOUND: 'Session {sessionId} is not registered',
    SESSION_EXISTS: 'Session {sessionId} already exists',
    INVALID_SESSION_ID: 'Session id must match ^[A-Za-z0-9_-]{1,64}$',
    SESSION_NOT_READY: 'Session {sessionId} is {state}, expected one of {expected}',
    SESSION_LOCKED: 'Session {sessionId} is held by instance {owner}',
    SESSION_LOGGED_OUT: 'Session {sessionId} is logged out and must be paired again',
    SESSION_FAILED: 'Session {sessionId} failed: {detail}',
    STORAGE_ERROR: 'Storage adapter {adapter} failed: {detail}',
    SEND_FAILED: 'Failed to send message on session {sessionId}: {detail}',
    LOGOUT_FAILED: 'Failed to unlink session {sessionId} from the phone: {detail}',
    MEDIA_DOWNLOAD_FAILED: 'Failed to download media for message {messageId} on session {sessionId}: {detail}',
    TIMEOUT: 'Operation {operation} timed out after {timeoutMs}ms',
    MISSING_PEER: '{feature} requires the peer dependency {peer}; install it with {install}',
    INVALID_CONFIG: 'Invalid config at {path}: {detail}',
    CLIENT_DESTROYED: 'Client has been destroyed',
    PAIRING_UNAVAILABLE: 'Pairing code cannot be requested while session {sessionId} is {state}',
    PAIRING_IN_PROGRESS: 'A pairing code is already pending for session {sessionId}',
    INVALID_PHONE_NUMBER: 'Invalid phone number: {detail}',
    INVALID_JID: 'Cannot derive a JID from {input}',
    LISTENER_FAILED: 'An event listener for {event} failed: {detail}',
    ILLEGAL_TRANSITION: 'Session {sessionId} cannot move from {from} via {trigger}',
};

/** Whether repeating the identical call could plausibly succeed. */
export const ERROR_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
    SESSION_NOT_FOUND: false,
    SESSION_EXISTS: false,
    INVALID_SESSION_ID: false,
    SESSION_NOT_READY: true,
    SESSION_LOCKED: true,
    SESSION_LOGGED_OUT: false,
    SESSION_FAILED: true,
    STORAGE_ERROR: true,
    SEND_FAILED: true,
    LOGOUT_FAILED: true,
    MEDIA_DOWNLOAD_FAILED: true,
    TIMEOUT: true,
    MISSING_PEER: false,
    INVALID_CONFIG: false,
    CLIENT_DESTROYED: false,
    PAIRING_UNAVAILABLE: true,
    PAIRING_IN_PROGRESS: false,
    INVALID_PHONE_NUMBER: false,
    INVALID_JID: false,
    LISTENER_FAILED: false,
    ILLEGAL_TRANSITION: false,
};

/**
 * The status the REST control plane answers with. Shared by both runtimes, so an API
 * client that branches on the status never has to ask which build it is talking to.
 */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
    SESSION_NOT_FOUND: 404,
    SESSION_EXISTS: 409,
    INVALID_SESSION_ID: 422,
    SESSION_NOT_READY: 409,
    SESSION_LOCKED: 409,
    SESSION_LOGGED_OUT: 409,
    SESSION_FAILED: 500,
    STORAGE_ERROR: 500,
    SEND_FAILED: 503,
    LOGOUT_FAILED: 502,
    MEDIA_DOWNLOAD_FAILED: 502,
    TIMEOUT: 504,
    MISSING_PEER: 501,
    INVALID_CONFIG: 422,
    CLIENT_DESTROYED: 503,
    PAIRING_UNAVAILABLE: 409,
    PAIRING_IN_PROGRESS: 409,
    INVALID_PHONE_NUMBER: 422,
    INVALID_JID: 422,
    LISTENER_FAILED: 500,
    ILLEGAL_TRANSITION: 409,
};
