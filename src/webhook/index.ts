/**
 * The webhook forwarder: a plugin that watches the event bus and posts what crosses
 * the wire to an HTTP receiver.
 *
 * It is a plugin rather than a client feature because core keeps zero runtime
 * dependencies and because a forwarder is one of several things you might hang off the
 * same events. It reaches the network through `fetch` and nothing else, so this entry
 * point installs nothing.
 *
 * Defaults are in spec/config.yaml#webhook, and they are validated here rather than
 * trusted: an allow-list with a typo in it forwards nothing at all, and finding that
 * out from a silent receiver hours later is the failure this check exists to prevent.
 */
import { WhatsMultiError } from '../errors.js';
import type { EventBatch, EventMeta } from '../events/types.js';
import type { Plugin, PluginContext } from '../plugin.js';

import {
    DeliveryQueue,
    type DeadLetter,
    type DeliveryConfig,
    type DeliveryStats,
    type FetchLike,
    type RetryConfig,
} from './delivery.js';
import { FORWARDABLE_EVENTS, toWebhookEvents, type WebhookEvent } from './envelope.js';

export {
    DeliveryQueue,
    isRetryableStatus,
    parseRetryAfter,
    type DeadLetter,
    type DeadLetterReason,
    type Delivery,
    type DeliveryConfig,
    type DeliveryQueueOptions,
    type DeliveryStats,
    type FetchLike,
    type RetryConfig,
    type WebhookRequestInit,
    type WebhookResponse,
} from './delivery.js';
export {
    buildEnvelope,
    encodeEnvelope,
    FORWARDABLE_EVENTS,
    toWebhookEvents,
    wireName,
    type WebhookEnvelope,
    type WebhookEvent,
} from './envelope.js';
export {
    DEFAULT_TOLERANCE_SECONDS,
    DELIVERY_HEADER,
    INSTANCE_HEADER,
    SIGNATURE_HEADER,
    parseSignatureHeader,
    signPayload,
    signedPayload,
    verifySignature,
    type Signature,
    type VerifyOptions,
} from './signature.js';

export interface WebhookOptions {
    /** http or https. */
    readonly url: string;
    /** HMAC-SHA256 signing key. Required: an unsigned webhook is unauthenticatable. */
    readonly secret: string;
    /**
     * Canonical event names to forward. Omit to forward everything that crosses the
     * wire. Names are the ones in spec/events.yaml, never the driver's own.
     */
    readonly events?: readonly string[] | undefined;
    readonly timeoutMs?: number | undefined;
    /** 0 posts each driver batch as it arrives. */
    readonly batchWindowMs?: number | undefined;
    readonly maxBatchSize?: number | undefined;
    readonly maxQueue?: number | undefined;
    readonly drainTimeoutMs?: number | undefined;
    readonly retry?: { readonly [K in keyof RetryConfig]?: RetryConfig[K] | undefined } | undefined;
    /** Merged into every request. Cannot override the signature or delivery headers. */
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly onDeadLetter?: ((letter: DeadLetter) => unknown) | undefined;
    /** Defaults to the global fetch. Injected in tests. */
    readonly fetch?: FetchLike | undefined;
    /** Plugin name. Give a second forwarder its own, or registration refuses it. */
    readonly name?: string | undefined;
    readonly now?: (() => number) | undefined;
    readonly random?: (() => number) | undefined;
    readonly newId?: (() => string) | undefined;
}

/** spec/config.yaml#webhook. The Go build reads the same defaults. */
export const DEFAULT_WEBHOOK = Object.freeze({
    timeoutMs: 10_000,
    batchWindowMs: 0,
    maxBatchSize: 100,
    maxQueue: 1000,
    drainTimeoutMs: 5000,
    retry: Object.freeze({ maxAttempts: 5, baseMs: 1000, capMs: 60_000, floorMs: 250 }),
});

export interface WebhookStats extends DeliveryStats {
    /**
     * Events collected but not yet posted, because the batch window is still open.
     * Counted apart from `queued`, which counts deliveries: reporting them as one
     * number would make a health check read zero while events sit unsent.
     */
    readonly pending: number;
}

export interface WebhookPlugin extends Plugin {
    /** Counters, for a metrics endpoint or a health check. */
    readonly stats: WebhookStats;
    /** Posts whatever is sitting in the batch window right now. */
    flush(): void;
}

const invalid = (path: string, detail: string) => new WhatsMultiError('INVALID_CONFIG', { params: { path, detail } });

function num(path: string, value: number | undefined, fallback: number, min: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw invalid(path, `expected an integer, received ${String(value)}`);
    }
    if (value < min) throw invalid(path, `must be >= ${min}, received ${value}`);
    return value;
}

function url(value: string): string {
    if (typeof value !== 'string' || value.length === 0) throw invalid('webhook.url', 'expected a non-empty string');

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw invalid('webhook.url', `not a valid URL: ${value}`);
    }

    // A `file:` or `data:` destination is not a webhook, and letting one through would
    // turn a config typo into a local file read.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw invalid('webhook.url', `expected http or https, received ${parsed.protocol}`);
    }
    return value;
}

function allowList(events: readonly string[] | undefined): ReadonlySet<string> | undefined {
    if (events === undefined) return undefined;

    const unknown = events.filter((event) => !FORWARDABLE_EVENTS.includes(event));
    if (unknown.length > 0) {
        // A driver-native name here is the likely mistake: it works nowhere, and an
        // allow-list that matches nothing is indistinguishable from a dead receiver.
        throw invalid('webhook.events', `unknown event name(s): ${unknown.join(', ')}`);
    }
    return new Set(events);
}

function resolve(options: WebhookOptions): DeliveryConfig {
    const d = DEFAULT_WEBHOOK;

    if (typeof options.secret !== 'string' || options.secret.length === 0) {
        throw invalid('webhook.secret', 'expected a non-empty string; the receiver cannot authenticate without one');
    }

    const retry: RetryConfig = {
        maxAttempts: num('webhook.retry.max_attempts', options.retry?.maxAttempts, d.retry.maxAttempts, 1),
        baseMs: num('webhook.retry.base_ms', options.retry?.baseMs, d.retry.baseMs, 100),
        capMs: num('webhook.retry.cap_ms', options.retry?.capMs, d.retry.capMs, 1000),
        floorMs: num('webhook.retry.floor_ms', options.retry?.floorMs, d.retry.floorMs, 0),
    };
    if (retry.capMs < retry.baseMs) {
        throw invalid('webhook.retry.cap_ms', `must be >= webhook.retry.base_ms (${retry.baseMs})`);
    }

    return {
        url: url(options.url),
        secret: options.secret,
        timeoutMs: num('webhook.timeout_ms', options.timeoutMs, d.timeoutMs, 1000),
        maxQueue: num('webhook.max_queue', options.maxQueue, d.maxQueue, 1),
        drainTimeoutMs: num('webhook.drain_timeout_ms', options.drainTimeoutMs, d.drainTimeoutMs, 0),
        retry,
        headers: options.headers ?? {},
    };
}

/**
 * An HTTP forwarder for a WhatsMulti client.
 *
 * ```ts
 * client.use(webhook({ url: 'https://example.test/hook', secret: process.env.WHSEC! }));
 * ```
 */
export function webhook(options: WebhookOptions): WebhookPlugin {
    const config = resolve(options);
    const allow = allowList(options.events);
    const batchWindowMs = num('webhook.batch_window_ms', options.batchWindowMs, DEFAULT_WEBHOOK.batchWindowMs, 0);
    const maxBatchSize = num('webhook.max_batch_size', options.maxBatchSize, DEFAULT_WEBHOOK.maxBatchSize, 1);

    let queue: DeliveryQueue | undefined;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: WebhookEvent[] = [];

    const post = (events: readonly WebhookEvent[]): void => {
        // Chunked even on the immediate path: a history sync arrives as one driver
        // batch and would otherwise become a single enormous POST.
        for (let i = 0; i < events.length; i += maxBatchSize) {
            queue?.enqueue(events.slice(i, i + maxBatchSize));
        }
    };

    const flush = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        post(batch);
    };

    const collect = (batch: EventBatch, meta: EventMeta): void => {
        const events = toWebhookEvents(batch, meta, allow);
        if (events.length === 0) return;

        if (batchWindowMs === 0) {
            post(events);
            return;
        }

        pending.push(...events);
        if (pending.length >= maxBatchSize) {
            flush();
            return;
        }
        if (timer === undefined) {
            timer = setTimeout(flush, batchWindowMs);
            // A pending window must never be the reason a process stays alive.
            timer.unref?.();
        }
    };

    return {
        name: options.name ?? 'webhook',

        get stats(): WebhookStats {
            const delivery = queue?.stats ?? { queued: 0, delivered: 0, deadLettered: 0, retries: 0 };
            return { ...delivery, pending: pending.length };
        },

        flush,

        setup(context: PluginContext): void {
            queue = new DeliveryQueue({
                instanceId: context.instanceId,
                config,
                logger: context.logger,
                ...(options.onDeadLetter === undefined ? {} : { onDeadLetter: options.onDeadLetter }),
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                ...(options.now === undefined ? {} : { now: options.now }),
                ...(options.random === undefined ? {} : { random: options.random }),
                ...(options.newId === undefined ? {} : { newId: options.newId }),
            });

            // `process` rather than per-event listeners: the driver hands us a batch,
            // and one POST per batch is what the envelope's events array is for.
            unsubscribe = context.events.process(collect);
        },

        async dispose(): Promise<void> {
            unsubscribe?.();
            unsubscribe = undefined;
            // Flushed before closing, so the last window's events get their chance at
            // the drain grace rather than being dead-lettered unsent.
            flush();
            await queue?.close();
        },
    };
}
