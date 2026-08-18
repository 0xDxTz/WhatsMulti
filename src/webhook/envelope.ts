/**
 * The wire envelope, normative in spec/webhook.md.
 *
 * Two rules carry the whole "a receiver cannot tell which runtime sent this" promise:
 *
 * - Names are canonical. Lifecycle events keep their own names; driver-native events
 *   go out under `wire_mapping`, never as `messages.upsert`. In-process they stay
 *   idiomatic, because renaming them for TypeScript consumers would buy nothing.
 * - Only events named in the spec cross the wire. Baileys emits plenty that whatsmeow
 *   has no counterpart for; forwarding those would make the two builds diverge on the
 *   very first message.
 */
import { bufferReplacer } from '../auth/codec.js';
import type { EventBatch, EventMeta } from '../events/types.js';
import { BAILEYS_EVENT_TO_WIRE, LIFECYCLE_EVENTS, SPEC_VERSION, WIRE_EVENTS } from '../generated/index.js';

export interface WebhookEvent {
    /** A canonical name: spec/events.yaml#lifecycle or #wire_mapping. */
    readonly event: string;
    readonly sessionId: string;
    /** Unix milliseconds. */
    readonly ts: number;
    readonly data: unknown;
}

export interface WebhookEnvelope {
    readonly specVersion: string;
    readonly instanceId: string;
    readonly events: readonly WebhookEvent[];
}

/** Every name that may appear as `event`, and so every name an allow-list may name. */
export const FORWARDABLE_EVENTS: readonly string[] = Object.freeze([...LIFECYCLE_EVENTS, ...WIRE_EVENTS]);

const FORWARDABLE = new Set(FORWARDABLE_EVENTS);

/**
 * The canonical name for an in-process event name, or `null` if it does not cross the
 * wire.
 *
 * A lifecycle name passes through; a driver-native name is translated. Anything else
 * is in-process only -- `creds.update` and friends are Baileys' business, not a
 * receiver's.
 */
export function wireName(event: string): string | null {
    if (FORWARDABLE.has(event)) return event;
    return BAILEYS_EVENT_TO_WIRE[event] ?? null;
}

/**
 * Flattens a driver batch into wire events, dropping everything the receiver must not
 * see. `allow` is matched against the *canonical* name, so an allow-list reads the
 * same in both runtimes.
 */
export function toWebhookEvents(batch: EventBatch, meta: EventMeta, allow?: ReadonlySet<string>): WebhookEvent[] {
    const events: WebhookEvent[] = [];

    for (const [name, data] of Object.entries(batch)) {
        if (data === undefined) continue;
        const event = wireName(name);
        if (event === null) continue;
        if (allow !== undefined && !allow.has(event)) continue;
        events.push({ event, sessionId: meta.sessionId, ts: meta.ts, data });
    }

    return events;
}

/** Key order matters: the vectors sign the serialised bytes, not the object. */
export function buildEnvelope(instanceId: string, events: readonly WebhookEvent[]): WebhookEnvelope {
    return { specVersion: SPEC_VERSION, instanceId, events };
}

/**
 * The exact bytes that get signed and posted.
 *
 * `bufferReplacer` is the same encoder the auth store uses, so binary appears as
 * `{ type: 'Buffer', data: <base64> }` on the wire and at rest. One encoding, one
 * thing for a receiver -- and for the Go build -- to implement.
 *
 * Throws whatever `JSON.stringify` throws: a cycle, a BigInt, a `toJSON` that fails.
 * The caller dead-letters it, because posting a truncated event is worse than not
 * posting it.
 */
export function encodeEnvelope(envelope: WebhookEnvelope): string {
    return JSON.stringify(envelope, bufferReplacer);
}
