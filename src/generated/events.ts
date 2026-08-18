// Code generated from spec/events.yaml by scripts/generate.mjs. DO NOT EDIT.
// Spec version: 0.2.13

export const LIFECYCLE_EVENTS = [
    'qr',
    'pairing.code',
    'session.created',
    'session.state',
    'session.reconnecting',
    'session.logged_out',
    'session.removed',
    'session.fenced',
    'session.error',
] as const;

export type LifecycleEvent =
    | 'qr'
    | 'pairing.code'
    | 'session.created'
    | 'session.state'
    | 'session.reconnecting'
    | 'session.logged_out'
    | 'session.removed'
    | 'session.fenced'
    | 'session.error';

export const WIRE_EVENTS = [
    'message.received',
    'message.updated',
    'receipt.updated',
    'presence.updated',
    'contact.updated',
    'group.updated',
    'history.synced',
] as const;

export type WireEvent =
    | 'message.received'
    | 'message.updated'
    | 'receipt.updated'
    | 'presence.updated'
    | 'contact.updated'
    | 'group.updated'
    | 'history.synced';

/** Driver-native event name -> canonical wire name. In-process names stay idiomatic. */
export const BAILEYS_EVENT_TO_WIRE: Readonly<Record<string, WireEvent>> = {
    'messages.upsert': 'message.received',
    'messages.update': 'message.updated',
    'message-receipt.update': 'receipt.updated',
    'presence.update': 'presence.updated',
    'contacts.update': 'contact.updated',
    'groups.update': 'group.updated',
    'messaging-history.set': 'history.synced',
};
