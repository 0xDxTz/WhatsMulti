import type { BaileysEventMap, WASocket } from '../compat/baileys.js';
import type { DisconnectCause, ErrorCode, LifecycleEvent, SessionState, SessionTrigger } from '../generated/index.js';

/** Envelope attached to every emitted event. Mirrors spec/events.yaml#meta. */
export interface EventMeta {
    readonly sessionId: string;
    readonly instanceId: string;
    /** Unix milliseconds. */
    readonly ts: number;
    /** Absent until the session has an open socket. */
    readonly socket?: WASocket | undefined;
}

export interface QrEvent {
    readonly qr: string;
    /** 1-based. Resets on a successful open. */
    readonly attempt: number;
    /** Unix milliseconds. */
    readonly expiresAt: number;
}

export interface PairingCodeEvent {
    /** Formatted `XXXX-XXXX`. */
    readonly code: string;
    /** Digits only, no leading `+`. */
    readonly phoneNumber: string;
    readonly expiresAt: number;
}

export interface SessionCreatedEvent {
    readonly storage: string;
}

export interface SessionStateEvent {
    readonly from: SessionState;
    readonly to: SessionState;
    readonly reason?: SessionTrigger | undefined;
}

export interface SessionReconnectingEvent {
    readonly attempt: number;
    readonly delayMs: number;
    readonly cause: DisconnectCause;
}

export interface SessionLoggedOutEvent {
    readonly cause: DisconnectCause;
}

export interface SessionRemovedEvent {
    readonly reason: 'deleted' | 'logged_out';
}

export interface SessionFencedEvent {
    /** The instanceId that now holds the lock. */
    readonly owner: string;
}

export interface SessionErrorEvent {
    readonly code: ErrorCode;
    readonly message: string;
}

/** Hand-written, but held to spec/events.yaml by the compile-time check below. */
export interface LifecycleEventMap {
    qr: QrEvent;
    'pairing.code': PairingCodeEvent;
    'session.created': SessionCreatedEvent;
    'session.state': SessionStateEvent;
    'session.reconnecting': SessionReconnectingEvent;
    'session.logged_out': SessionLoggedOutEvent;
    'session.removed': SessionRemovedEvent;
    'session.fenced': SessionFencedEvent;
    'session.error': SessionErrorEvent;
}

/** Fails to compile if this map and spec/events.yaml#lifecycle disagree. */
type MissingLifecycle = Exclude<LifecycleEvent, keyof LifecycleEventMap>;
type ExtraLifecycle = Exclude<keyof LifecycleEventMap, LifecycleEvent>;
const _lifecycleMatchesSpec: [MissingLifecycle, ExtraLifecycle] extends [never, never] ? true : never = true;
void _lifecycleMatchesSpec;

/**
 * Driver-native events stay under their native names in-process; only the wire
 * format is normalised (spec/events.yaml#wire_mapping). Renaming `messages.upsert`
 * for TypeScript consumers would buy nothing and break every existing handler.
 */
export type EventMap = LifecycleEventMap & BaileysEventMap;

export type EventName = keyof EventMap;

export type EventListener<K extends EventName> = (data: EventMap[K], meta: EventMeta) => unknown;

/**
 * Receives the driver's buffered batch intact. v1 re-split it into one call per
 * event, discarding the batching Baileys works to provide.
 */
export type EventBatch = { [K in keyof EventMap]?: EventMap[K] | undefined };

export type EventBatchListener = (events: EventBatch, meta: EventMeta) => unknown;
