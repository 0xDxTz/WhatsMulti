/**
 * @dutakey/whatsmulti — multi-session WhatsApp orchestration built on Baileys.
 *
 * The rewrite lands phase by phase; see docs/REWRITE-v2-PLAN.md. Everything exported
 * from `generated/` is compiled from `spec/` and is identical in the planned Go
 * implementation.
 */

// --- spec surface (generated from spec/) -----------------------------------------
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

// --- errors -----------------------------------------------------------------------
export {
    WhatsMultiError,
    formatErrorMessage,
    isWhatsMultiError,
    hasErrorCode,
    wrapError,
    describeError,
} from './errors.js';
export type { ErrorParams, SerializedError, WhatsMultiErrorOptions } from './errors.js';

// --- logging ----------------------------------------------------------------------
export { createLogger, silentLogger, resolveLogger, isLogLevel, LOG_LEVELS } from './logger.js';
export type { Logger, LogFn, LogLevel, ConsoleLoggerOptions } from './logger.js';

// --- configuration ----------------------------------------------------------------
export {
    resolveConfig,
    generateInstanceId,
    isValidSessionId,
    assertValidSessionId,
    DEFAULT_CONFIG,
    SESSION_ID_PATTERN,
} from './config.js';
export type {
    WhatsMultiConfig,
    ResolvedConfig,
    ReconnectConfig,
    QrConfig,
    PairingConfig,
    SendConfig,
    LockConfig,
    LoadConfig,
} from './config.js';

// --- events -----------------------------------------------------------------------
export { WMEventEmitter } from './events/index.js';
export type {
    EmitterOptions,
    EventBatch,
    EventBatchListener,
    EventListener,
    EventMap,
    EventMeta,
    EventName,
    LifecycleEventMap,
    PairingCodeEvent,
    QrEvent,
    SessionCreatedEvent,
    SessionErrorEvent,
    SessionFencedEvent,
    SessionLoggedOutEvent,
    SessionReconnectingEvent,
    SessionRemovedEvent,
    SessionStateEvent,
} from './events/index.js';

// --- plugins ----------------------------------------------------------------------
export { PluginRegistry, definePlugin } from './plugin.js';
export type { Plugin, PluginContext, PluginEvents } from './plugin.js';

// --- driver compatibility ---------------------------------------------------------
export { SIGNAL_KEY_TYPES, RESERVED_KEYS, resolveDisconnectCause, readStatusCode } from './compat/baileys.js';
export type { SignalKeyType } from './compat/baileys.js';
