/**
 * @dutakey/whatsmulti — multi-session WhatsApp orchestration built on Baileys.
 *
 * The rewrite lands phase by phase (see docs/REWRITE-v2-PLAN.md). What is exported
 * here is the spec surface: the enums and constants that are generated from `spec/`
 * and are therefore identical in the Go implementation.
 */
export {
    SPEC_VERSION,
    SESSION_STATES,
    SESSION_TRIGGERS,
    INITIAL_STATE,
    TERMINAL_STATES,
    SENDABLE_STATES,
    PAIRABLE_STATES,
    TRANSITIONS,
    DISCONNECT_CAUSES,
    DISCONNECT_ACTIONS,
    PURGES_CREDS,
    ERROR_CODES,
    ERROR_MESSAGES,
    ERROR_RETRYABLE,
    LIFECYCLE_EVENTS,
    WIRE_EVENTS,
} from './generated/index.js';

export type {
    SessionState,
    SessionTrigger,
    DisconnectCause,
    DisconnectAction,
    ErrorCode,
    LifecycleEvent,
    WireEvent,
} from './generated/index.js';
