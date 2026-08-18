import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { EventBatch, EventMeta } from '../../src/events/types.js';
import { LIFECYCLE_EVENTS, SPEC_VERSION, WIRE_EVENTS } from '../../src/generated/index.js';
import {
    buildEnvelope,
    encodeEnvelope,
    FORWARDABLE_EVENTS,
    toWebhookEvents,
    wireName,
} from '../../src/webhook/envelope.js';

const meta: EventMeta = { sessionId: 'session-1', instanceId: 'host:1234:a1b2c3', ts: 1_755_500_000_000 };

describe('wireName', () => {
    it('passes a lifecycle name through unchanged', () => {
        for (const event of LIFECYCLE_EVENTS) expect(wireName(event)).toBe(event);
    });

    it('translates driver-native names to the canonical ones', () => {
        // The one place the two runtimes would otherwise be distinguishable: a
        // receiver must never see `messages.upsert`.
        expect(wireName('messages.upsert')).toBe('message.received');
        expect(wireName('message-receipt.update')).toBe('receipt.updated');
        expect(wireName('messaging-history.set')).toBe('history.synced');
    });

    it('accepts a canonical wire name that arrives already translated', () => {
        for (const event of WIRE_EVENTS) expect(wireName(event)).toBe(event);
    });

    it.each(['creds.update', 'chats.upsert', 'connection.update', 'blocklist.set', 'made.up'])(
        'refuses %s, which whatsmeow has no counterpart for',
        (event) => {
            expect(wireName(event)).toBeNull();
        }
    );

    it('lists exactly the lifecycle and wire names as forwardable', () => {
        expect([...FORWARDABLE_EVENTS].sort()).toEqual([...LIFECYCLE_EVENTS, ...WIRE_EVENTS].sort());
    });
});

describe('toWebhookEvents', () => {
    it('flattens a driver batch, tagging each event from the envelope', () => {
        const batch = {
            'messages.upsert': { messages: [] },
            'session.state': { from: 'connecting', to: 'open' },
        } as unknown as EventBatch;

        expect(toWebhookEvents(batch, meta)).toEqual([
            { event: 'message.received', sessionId: 'session-1', ts: meta.ts, data: { messages: [] } },
            { event: 'session.state', sessionId: 'session-1', ts: meta.ts, data: { from: 'connecting', to: 'open' } },
        ]);
    });

    it('drops in-process-only events', () => {
        const batch = { 'creds.update': {}, 'messages.upsert': { messages: [] } } as unknown as EventBatch;
        expect(toWebhookEvents(batch, meta).map((e) => e.event)).toEqual(['message.received']);
    });

    it('skips keys present but undefined', () => {
        const batch = { 'messages.upsert': undefined, qr: { qr: 'x', attempt: 1, expiresAt: 0 } } as EventBatch;
        expect(toWebhookEvents(batch, meta).map((e) => e.event)).toEqual(['qr']);
    });

    it('applies the allow-list to the canonical name, not the driver name', () => {
        // An allow-list written against `messages.upsert` would work in TypeScript and
        // silently forward nothing in Go.
        const batch = { 'messages.upsert': { messages: [] }, qr: { qr: 'x' } } as unknown as EventBatch;
        const allow = new Set(['message.received']);
        expect(toWebhookEvents(batch, meta, allow).map((e) => e.event)).toEqual(['message.received']);
        expect(toWebhookEvents(batch, meta, new Set(['messages.upsert']))).toEqual([]);
    });

    it('returns an empty array for a batch with nothing forwardable', () => {
        expect(toWebhookEvents({ 'creds.update': {} } as unknown as EventBatch, meta)).toEqual([]);
    });
});

describe('buildEnvelope', () => {
    it('stamps the spec version the code was generated from', () => {
        expect(buildEnvelope('i', []).specVersion).toBe(SPEC_VERSION);
    });

    it('serialises its keys in the order the signature vectors assume', () => {
        // The MAC covers bytes, so key order is part of the contract, not a detail.
        expect(encodeEnvelope(buildEnvelope('i', []))).toBe(
            `{"specVersion":"${SPEC_VERSION}","instanceId":"i","events":[]}`
        );
    });

    it('reproduces a vector body byte for byte', () => {
        const vector = JSON.parse(
            readFileSync(join(process.cwd(), 'spec', 'vectors', 'webhook-signature.json'), 'utf8')
        ) as { cases: { body: string }[] };

        const envelope = buildEnvelope('host:1234:a1b2c3', [
            {
                event: 'session.state',
                sessionId: 'session-1',
                ts: 1_755_500_000_000,
                data: { from: 'connecting', to: 'open' },
            },
        ]);
        expect(encodeEnvelope(envelope)).toBe(vector.cases[0]?.body);
    });
});

describe('encodeEnvelope', () => {
    it('encodes binary the way the auth store does', () => {
        const envelope = buildEnvelope('i', [
            { event: 'message.received', sessionId: 's', ts: 1, data: { key: Buffer.from([0, 1, 2]) } },
        ]);
        expect(JSON.parse(encodeEnvelope(envelope))).toMatchObject({
            events: [{ data: { key: { type: 'Buffer', data: 'AAEC' } } }],
        });
    });

    it('encodes a bare Uint8Array too', () => {
        // A Buffer arrives here already turned into {type,data:[bytes]} by its toJSON;
        // a plain Uint8Array has none and arrives intact. Both have to land as base64.
        const envelope = buildEnvelope('i', [
            { event: 'message.received', sessionId: 's', ts: 1, data: Uint8Array.from([255, 0]) },
        ]);
        expect(JSON.parse(encodeEnvelope(envelope))).toMatchObject({
            events: [{ data: { type: 'Buffer', data: '/wA=' } }],
        });
    });

    it('throws on a payload JSON cannot represent', () => {
        // The caller dead-letters this. Posting a truncated event would be worse.
        const cycle: Record<string, unknown> = {};
        cycle['self'] = cycle;
        const envelope = buildEnvelope('i', [{ event: 'message.received', sessionId: 's', ts: 1, data: cycle }]);
        expect(() => encodeEnvelope(envelope)).toThrow(TypeError);
    });
});
