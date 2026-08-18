export { Session, formatPairingCode, type SessionOptions } from './session.js';
export { SessionManager, type CreateSessionOptions, type SessionManagerOptions } from './manager.js';
export { SessionRegistry, type SessionMeta } from './registry.js';
export {
    SessionMachine,
    isPairable,
    isSendable,
    isSessionState,
    isTerminal,
    nextState,
    type SessionMachineOptions,
    type Transition,
} from './state.js';
export { decideDisconnect, decisionFor, disconnectTrigger, type DisconnectDecision } from './disconnect.js';
export {
    ReconnectPolicy,
    backoffDelay,
    type BackoffConfig,
    type ReconnectPlan,
    type ReconnectPolicyOptions,
    type ReconnectRefusal,
} from './reconnect.js';
export { createSocket, toDriverLogger, type SocketFactory, type SocketFactoryOptions } from './socket-factory.js';
