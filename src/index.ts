/**
 * @dutakey/whatsmulti — multi-session WhatsApp orchestration built on Baileys.
 *
 * The rewrite lands phase by phase; see docs/REWRITE-v2-PLAN.md. Everything exported
 * from `generated/` is compiled from `spec/` and is identical in the planned Go
 * implementation.
 */

// --- client ------------------------------------------------------------------------
// The QR renderer is deliberately not re-exported here: it lives on the `./qr`
// subpath so that core keeps zero runtime dependencies.
export { WhatsMulti } from './client.js';
export type { WhatsMultiOptions } from './client.js';

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

// --- storage ----------------------------------------------------------------------
export {
    memoryStorage,
    fileStorage,
    resolveStorage,
    DEFAULT_STORAGE_PATH,
    NAMESPACE,
    SEPARATOR,
    encodeKey,
    decodeKey,
    sessionPrefix,
    namespacePrefix,
    storageKey,
    parseStorageKey,
    requireStorageKey,
} from './storage/index.js';
export type {
    StorageAdapter,
    StorageInput,
    StorageValue,
    MemoryStorageOptions,
    FileStorageOptions,
    ParsedStorageKey,
} from './storage/index.js';

// --- auth --------------------------------------------------------------------------
export {
    useAuthState,
    CREDS_KEY,
    META_KEY,
    RESERVED_KEY_NAMES,
    STORAGE_KEYS,
    isReservedKey,
    isSignalKeyType,
    parseSignalKey,
    signalKey,
    encodeValue,
    decodeValue,
    encodeJson,
    decodeJson,
    bufferReplacer,
    bufferReviver,
} from './auth/index.js';
export type { AuthStateHandle, AuthStateOptions, EncodedBuffer, ParsedSignalKey } from './auth/index.js';

// --- sessions ----------------------------------------------------------------------
export {
    Session,
    SessionManager,
    SessionMachine,
    SessionRegistry,
    ReconnectPolicy,
    backoffDelay,
    createSocket,
    decideDisconnect,
    decisionFor,
    disconnectTrigger,
    formatPairingCode,
    isPairable,
    isSendable,
    isSessionState,
    isTerminal,
    nextState,
} from './session/index.js';
export type {
    BackoffConfig,
    CreateSessionOptions,
    DisconnectDecision,
    ReconnectPlan,
    ReconnectPolicyOptions,
    ReconnectRefusal,
    SessionManagerOptions,
    SessionMachineOptions,
    SessionMeta,
    SessionOptions,
    SocketFactory,
    SocketFactoryOptions,
    Transition,
} from './session/index.js';

// --- messaging ---------------------------------------------------------------------
export {
    DEFAULT_SERVER,
    KNOWN_SERVERS,
    SendQueue,
    downloadMedia,
    downloadMediaStream,
    isJid,
    isKnownServer,
    normalizeJid,
    normalizePhoneNumber,
    parseJid,
    sendMessage,
} from './messaging/index.js';
export type { DownloadRequest, KnownServer, ParsedJid, SendQueueOptions, SendRequest } from './messaging/index.js';

// --- utilities ---------------------------------------------------------------------
export { mapLimit } from './utils/concurrency.js';
export { withTimeout, type TimeoutOptions } from './utils/timeout.js';
export { createRandom, mulberry32, randomSeed } from './utils/random.js';

// --- locking ----------------------------------------------------------------------
export { memoryLock, sessionLockKey } from './lock.js';
export type { LockProvider, LockToken, MemoryLockOptions } from './lock.js';

// --- plugins ----------------------------------------------------------------------
export { PluginRegistry, definePlugin } from './plugin.js';
export type { Plugin, PluginContext, PluginEvents } from './plugin.js';

// --- driver compatibility ---------------------------------------------------------
export { SIGNAL_KEY_TYPES, RESERVED_KEYS, resolveDisconnectCause, readStatusCode } from './compat/baileys.js';
export type { SignalKeyType } from './compat/baileys.js';
export { loadDriver, setDriverLoader } from './compat/driver.js';
export { toDriverLogger } from './compat/driver-logger.js';
export type { BaileysModule, DriverLoader } from './compat/driver.js';
