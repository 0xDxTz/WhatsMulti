import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { resolveConfig } from '../../src/config.js';
import { WMEventEmitter } from '../../src/events/emitter.js';
import type { EventBatch, EventMeta } from '../../src/events/types.js';
import { silentLogger } from '../../src/logger.js';
import { PluginRegistry, type PluginContext } from '../../src/plugin.js';
import type { FetchLike, WebhookRequestInit, WebhookResponse } from '../../src/webhook/delivery.js';
import { DEFAULT_WEBHOOK, webhook } from '../../src/webhook/index.js';
import { verifySignature } from '../../src/webhook/signature.js';

const spec = parse(readFileSync(join(process.cwd(), 'spec', 'config.yaml'), 'utf8')) as Record<string, never>;
const specDefault = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], spec);

const SECRET = 'whsec_test';
const URL = 'https://receiver.test/hook';

const meta: EventMeta = { sessionId: 'session-1', instanceId: 'host:1:abc', ts: 1_755_500_000_000 };

const respond = (status = 200): WebhookResponse => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
});

function recorder(): { fetch: FetchLike; calls: WebhookRequestInit[] } {
    const calls: WebhookRequestInit[] = [];
    return {
        calls,
        fetch: (_url, init) => {
            calls.push(init);
            return Promise.resolve(respond());
        },
    };
}

const bodies = (calls: WebhookRequestInit[]): { events: { event: string; sessionId: string }[] }[] =>
    calls.map((c) => JSON.parse(c.body) as { events: { event: string; sessionId: string }[] });

const context = (emitter: WMEventEmitter): PluginContext => ({
    instanceId: 'host:1:abc',
    config: resolveConfig({ instanceId: 'host:1:abc' }),
    logger: silentLogger,
    events: emitter,
});

/** Wires the plugin to a live emitter, the way the client does. */
async function harness(options: Parameters<typeof webhook>[0]) {
    const emitter = new WMEventEmitter();
    const plugin = webhook(options);
    const registry = new PluginRegistry();
    registry.register(plugin);
    await registry.setup(context(emitter));
    return { emitter, plugin, registry };
}

describe('defaults match spec/config.yaml#webhook', () => {
    // The Go build reads the same file. A receiver must not be able to tell which
    // runtime sent the request, and that includes how long it waits between retries.
    it.each([
        ['webhook.timeout_ms.default', DEFAULT_WEBHOOK.timeoutMs],
        ['webhook.batch_window_ms.default', DEFAULT_WEBHOOK.batchWindowMs],
        ['webhook.max_batch_size.default', DEFAULT_WEBHOOK.maxBatchSize],
        ['webhook.max_queue.default', DEFAULT_WEBHOOK.maxQueue],
        ['webhook.drain_timeout_ms.default', DEFAULT_WEBHOOK.drainTimeoutMs],
        ['webhook.retry.max_attempts.default', DEFAULT_WEBHOOK.retry.maxAttempts],
        ['webhook.retry.base_ms.default', DEFAULT_WEBHOOK.retry.baseMs],
        ['webhook.retry.cap_ms.default', DEFAULT_WEBHOOK.retry.capMs],
        ['webhook.retry.floor_ms.default', DEFAULT_WEBHOOK.retry.floorMs],
    ])('%s', (path, value) => {
        expect(specDefault(path)).toBe(value);
    });

    it.each([
        ['webhook.timeout_ms.min', 'timeoutMs'],
        ['webhook.max_queue.min', 'maxQueue'],
        ['webhook.max_batch_size.min', 'maxBatchSize'],
        ['webhook.retry.base_ms.min', 'retry'],
    ] as const)('rejects a value below the spec minimum for %s', (path, key) => {
        const min = specDefault(path) as number;
        const options =
            key === 'retry'
                ? { url: URL, secret: SECRET, retry: { baseMs: min - 1 } }
                : { url: URL, secret: SECRET, [key]: min - 1 };
        expect(() => webhook(options)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }) as Error);
    });
});

describe('option validation', () => {
    it.each([
        ['an empty url', { url: '', secret: SECRET }],
        ['a url that is not one', { url: 'not a url', secret: SECRET }],
        ['a file: destination', { url: 'file:///etc/passwd', secret: SECRET }],
        ['a missing secret', { url: URL, secret: '' }],
        ['a fractional timeout', { url: URL, secret: SECRET, timeoutMs: 1500.5 }],
        ['a negative batch window', { url: URL, secret: SECRET, batchWindowMs: -1 }],
        ['a cap below the base', { url: URL, secret: SECRET, retry: { baseMs: 5000, capMs: 1000 } }],
    ])('refuses %s', (_label, options) => {
        expect(() => webhook(options as Parameters<typeof webhook>[0])).toThrow(
            expect.objectContaining({ code: 'INVALID_CONFIG' }) as Error
        );
    });

    it('refuses an allow-list naming an event that does not exist', () => {
        // A driver-native name is the likely mistake, and an allow-list that matches
        // nothing looks exactly like a dead receiver.
        expect(() => webhook({ url: URL, secret: SECRET, events: ['messages.upsert'] })).toThrow(
            expect.objectContaining({ code: 'INVALID_CONFIG' }) as Error
        );
        expect(() => webhook({ url: URL, secret: SECRET, events: ['message.received'] })).not.toThrow();
    });

    it('accepts http as well as https', () => {
        expect(() => webhook({ url: 'http://localhost:3000/hook', secret: SECRET })).not.toThrow();
    });

    it('takes its name from the options so a second forwarder can register', async () => {
        const registry = new PluginRegistry();
        registry.register(webhook({ url: URL, secret: SECRET }));
        expect(() => registry.register(webhook({ url: URL, secret: SECRET }))).toThrow();
        expect(() => registry.register(webhook({ url: URL, secret: SECRET, name: 'webhook:audit' }))).not.toThrow();
    });
});

describe('forwarding', () => {
    it('posts a signed envelope for a driver batch', async () => {
        const rec = recorder();
        const { emitter, registry } = await harness({ url: URL, secret: SECRET, fetch: rec.fetch });

        emitter.emit('session.state', { from: 'connecting', to: 'open' }, meta);
        await registry.dispose(silentLogger);

        expect(rec.calls).toHaveLength(1);
        const call = rec.calls[0]!;
        expect(
            verifySignature({ body: call.body, header: call.headers['x-whatsmulti-signature']!, secret: SECRET })
        ).toBe(true);
        expect(bodies(rec.calls)[0]?.events).toEqual([
            { event: 'session.state', sessionId: 'session-1', ts: meta.ts, data: { from: 'connecting', to: 'open' } },
        ]);
    });

    it('translates driver-native names on the way out', async () => {
        const rec = recorder();
        const { emitter, registry } = await harness({ url: URL, secret: SECRET, fetch: rec.fetch });

        emitter.emitBatch({ 'messages.upsert': { messages: [] } } as unknown as EventBatch, meta);
        await registry.dispose(silentLogger);

        expect(bodies(rec.calls)[0]?.events[0]?.event).toBe('message.received');
    });

    it('forwards nothing for a batch of in-process-only events', async () => {
        const rec = recorder();
        const { emitter, registry } = await harness({ url: URL, secret: SECRET, fetch: rec.fetch });

        emitter.emitBatch({ 'creds.update': {} } as unknown as EventBatch, meta);
        await registry.dispose(silentLogger);

        expect(rec.calls).toEqual([]);
    });

    it('honours the allow-list', async () => {
        const rec = recorder();
        const { emitter, registry } = await harness({
            url: URL,
            secret: SECRET,
            events: ['session.state'],
            fetch: rec.fetch,
        });

        emitter.emit('session.state', { from: 'connecting', to: 'open' }, meta);
        emitter.emit('qr', { qr: 'x', attempt: 1, expiresAt: 0 }, meta);
        await registry.dispose(silentLogger);

        expect(bodies(rec.calls).flatMap((b) => b.events.map((e) => e.event))).toEqual(['session.state']);
    });

    it('keeps a whole driver batch in one delivery', async () => {
        const rec = recorder();
        const { emitter, registry } = await harness({ url: URL, secret: SECRET, fetch: rec.fetch });

        emitter.emitBatch(
            { 'messages.upsert': { messages: [] }, 'presence.update': { id: 'x' } } as unknown as EventBatch,
            meta
        );
        await registry.dispose(silentLogger);

        expect(rec.calls).toHaveLength(1);
        expect(bodies(rec.calls)[0]?.events).toHaveLength(2);
    });

    it('splits a batch that exceeds maxBatchSize', async () => {
        // A history sync arrives as one driver batch and would otherwise become a
        // single enormous POST.
        const rec = recorder();
        const { emitter, registry } = await harness({ url: URL, secret: SECRET, maxBatchSize: 1, fetch: rec.fetch });

        emitter.emitBatch(
            { 'messages.upsert': { messages: [] }, 'presence.update': { id: 'x' } } as unknown as EventBatch,
            meta
        );
        await registry.dispose(silentLogger);

        expect(rec.calls).toHaveLength(2);
    });
});

describe('batching', () => {
    it('holds events for the window, then posts them together', async () => {
        vi.useFakeTimers();
        try {
            const rec = recorder();
            const { emitter, plugin } = await harness({
                url: URL,
                secret: SECRET,
                batchWindowMs: 50,
                fetch: rec.fetch,
            });

            emitter.emit('session.state', { from: 'connecting', to: 'open' }, meta);
            emitter.emit('qr', { qr: 'x', attempt: 1, expiresAt: 0 }, meta);
            expect(rec.calls).toEqual([]);
            expect(plugin.stats.pending).toBe(2);

            vi.advanceTimersByTime(50);
            await vi.waitFor(() => expect(rec.calls).toHaveLength(1));
            expect(bodies(rec.calls)[0]?.events).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('posts early once the window has collected maxBatchSize events', async () => {
        vi.useFakeTimers();
        try {
            const rec = recorder();
            const { emitter } = await harness({
                url: URL,
                secret: SECRET,
                batchWindowMs: 60_000,
                maxBatchSize: 2,
                fetch: rec.fetch,
            });

            emitter.emit('session.state', { from: 'connecting', to: 'open' }, meta);
            emitter.emit('qr', { qr: 'x', attempt: 1, expiresAt: 0 }, meta);

            await vi.waitFor(() => expect(rec.calls).toHaveLength(1));
        } finally {
            vi.useRealTimers();
        }
    });

    it('flushes on demand', async () => {
        const rec = recorder();
        const { emitter, plugin, registry } = await harness({
            url: URL,
            secret: SECRET,
            batchWindowMs: 60_000,
            fetch: rec.fetch,
        });

        emitter.emit('session.state', { from: 'connecting', to: 'open' }, meta);
        plugin.flush();
        await vi.waitFor(() => expect(rec.calls).toHaveLength(1));
        await registry.dispose(silentLogger);
    });

    it('flushing an empty window posts nothing', async () => {
        const rec = recorder();
        const { plugin, registry } = await harness({
            url: URL,
            secret: SECRET,
            batchWindowMs: 60_000,
            fetch: rec.fetch,
        });

        plugin.flush();
        plugin.flush();
        await registry.dispose(silentLogger);

        expect(rec.calls).toEqual([]);
    });

    it('sends what the window still holds on dispose', async () => {
        // Otherwise a clean shutdown loses the last events, which is exactly when a
        // consumer is watching for `session.state`.
        const rec = recorder();
        const { emitter, registry } = await harness({
            url: URL,
            secret: SECRET,
            batchWindowMs: 60_000,
            fetch: rec.fetch,
        });

        emitter.emit('session.state', { from: 'connecting', to: 'open' }, meta);
        await registry.dispose(silentLogger);

        expect(rec.calls).toHaveLength(1);
    });
});

describe('lifecycle', () => {
    it('reports empty stats before setup', () => {
        expect(webhook({ url: URL, secret: SECRET }).stats).toEqual({
            queued: 0,
            pending: 0,
            delivered: 0,
            deadLettered: 0,
            retries: 0,
        });
    });

    it('reports delivery counters afterwards', async () => {
        const rec = recorder();
        const { emitter, plugin, registry } = await harness({ url: URL, secret: SECRET, fetch: rec.fetch });

        emitter.emit('session.state', { from: 'connecting', to: 'open' }, meta);
        await registry.dispose(silentLogger);

        expect(plugin.stats).toMatchObject({ delivered: 1, deadLettered: 0, queued: 0, pending: 0 });
    });

    it('stops listening once disposed', async () => {
        const rec = recorder();
        const { emitter, registry } = await harness({ url: URL, secret: SECRET, fetch: rec.fetch });

        await registry.dispose(silentLogger);
        emitter.emit('session.state', { from: 'connecting', to: 'open' }, meta);

        expect(rec.calls).toEqual([]);
    });

    it('disposes cleanly when it was never set up', async () => {
        await expect(webhook({ url: URL, secret: SECRET }).dispose?.()).resolves.toBeUndefined();
    });

    it('reports a dead letter to the caller', async () => {
        const letters: string[] = [];
        const { emitter, registry } = await harness({
            url: URL,
            secret: SECRET,
            fetch: () => Promise.resolve(respond(400)),
            onDeadLetter: (letter) => void letters.push(letter.reason),
        });

        emitter.emit('session.state', { from: 'connecting', to: 'open' }, meta);
        await registry.dispose(silentLogger);

        expect(letters).toEqual(['rejected']);
    });
});
