/**
 * The delivery queue: sign once, post in order, retry what is worth retrying, and
 * hand everything else to the dead letter.
 *
 * Deliveries go out one at a time. A receiver that sees `session.state open` before
 * the `qr` that preceded it has been told a lie about the session, and parallel posts
 * with independent retries make that the normal case rather than a race.
 *
 * Nothing here is dropped quietly. Overflow, a rejection, an exhausted retry schedule,
 * a payload that will not serialise and a shutdown that ran out of grace all arrive at
 * `onDeadLetter` with the reason attached. A forwarder that silently loses events is
 * indistinguishable from one that works.
 */
import { randomUUID } from 'node:crypto';

import { describeError } from '../errors.js';
import { SPEC_VERSION } from '../generated/index.js';
import { silentLogger, type Logger } from '../logger.js';
import { backoffDelay, type BackoffConfig } from '../utils/backoff.js';

import { buildEnvelope, encodeEnvelope, type WebhookEvent } from './envelope.js';
import { DELIVERY_HEADER, INSTANCE_HEADER, SIGNATURE_HEADER, signPayload } from './signature.js';

/** The response fields this module reads. Structural, so any fetch-alike fits. */
export interface WebhookResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly headers: { get(name: string): string | null };
}

export interface WebhookRequestInit {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
}

/** `globalThis.fetch` satisfies this; a test double is four lines. */
export type FetchLike = (url: string, init: WebhookRequestInit) => Promise<WebhookResponse>;

export interface RetryConfig extends BackoffConfig {
    /** Total attempts per delivery, not extra ones. */
    readonly maxAttempts: number;
}

export interface DeliveryConfig {
    readonly url: string;
    readonly secret: string;
    readonly timeoutMs: number;
    readonly maxQueue: number;
    readonly drainTimeoutMs: number;
    readonly retry: RetryConfig;
    readonly headers: Readonly<Record<string, string>>;
}

export interface Delivery {
    /** Stable across retries. The receiver's idempotency key. */
    readonly id: string;
    /** Unix seconds, signed into the MAC and reused unchanged across retries. */
    readonly t: number;
    /** The exact bytes that were signed. */
    readonly body: string;
    readonly signature: string;
    readonly events: readonly WebhookEvent[];
    /** Attempts made so far. */
    attempts: number;
}

export type DeadLetterReason =
    /** The queue was full. */
    | 'overflow'
    /** The receiver answered with a 4xx it will keep answering with. */
    | 'rejected'
    /** Every retry was used up. */
    | 'exhausted'
    /** The payload could not be serialised, so it was never sent. */
    | 'encode'
    /** Shutdown ran out of grace with the delivery still pending. */
    | 'shutdown';

export interface DeadLetter {
    readonly reason: DeadLetterReason;
    readonly events: readonly WebhookEvent[];
    readonly attempts: number;
    /** Absent when the failure never reached a response. */
    readonly status?: number | undefined;
    readonly detail?: string | undefined;
    /** Absent when the payload never made it to a signed delivery. */
    readonly delivery?: Delivery | undefined;
}

export interface DeliveryStats {
    readonly queued: number;
    readonly delivered: number;
    readonly deadLettered: number;
    /** Requests that failed and were retried. */
    readonly retries: number;
}

export interface DeliveryQueueOptions {
    readonly instanceId: string;
    readonly config: DeliveryConfig;
    readonly logger?: Logger | undefined;
    readonly onDeadLetter?: ((letter: DeadLetter) => unknown) | undefined;
    readonly fetch?: FetchLike | undefined;
    /** Unix milliseconds. Injected in tests. */
    readonly now?: (() => number) | undefined;
    readonly random?: (() => number) | undefined;
    readonly newId?: (() => string) | undefined;
}

/** spec/webhook.md: retry a transport error, a 5xx, a 408 or a 429. Nothing else. */
export function isRetryableStatus(status: number): boolean {
    return status >= 500 || status === 408 || status === 429;
}

/**
 * `Retry-After` as milliseconds, in either of the forms RFC 9110 allows.
 *
 * Not clamped. A receiver asking for an hour means it, and the bounded queue is what
 * keeps that from becoming unbounded memory -- overflow dead-letters loudly, which is
 * the signal a caller can act on.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
    if (value === null) return undefined;
    const trimmed = value.trim();
    if (trimmed === '') return undefined;

    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

    // Every HTTP-date form carries a month and a weekday name. Without this guard
    // `Date.parse` accepts things no receiver would send -- `-5` parses as a year --
    // and a malformed header would silently become a delay.
    if (!/[a-z]/i.test(trimmed)) return undefined;

    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    return Math.max(0, at - nowMs);
}

const USER_AGENT = `WhatsMulti/${SPEC_VERSION}`;

export class DeliveryQueue {
    readonly #config: DeliveryConfig;
    readonly #instanceId: string;
    readonly #logger: Logger;
    readonly #onDeadLetter: ((letter: DeadLetter) => unknown) | undefined;
    readonly #fetch: FetchLike;
    readonly #now: () => number;
    readonly #random: () => number;
    readonly #newId: () => string;

    readonly #queue: Delivery[] = [];
    readonly #idleWaiters = new Set<() => void>();

    #pumping = false;
    #closing = false;
    /** Unix ms after which shutdown stops waiting. */
    #deadline: number | undefined;
    #inflight: AbortController | undefined;
    #sleeper: { resolve: () => void; timer: ReturnType<typeof setTimeout> } | undefined;

    #delivered = 0;
    #deadLettered = 0;
    #retries = 0;

    constructor(options: DeliveryQueueOptions) {
        this.#config = options.config;
        this.#instanceId = options.instanceId;
        this.#logger = options.logger ?? silentLogger;
        this.#onDeadLetter = options.onDeadLetter;
        // Bound to globalThis: an unbound `fetch` reference throws "illegal invocation".
        this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
        this.#now = options.now ?? Date.now;
        this.#random = options.random ?? Math.random;
        this.#newId = options.newId ?? randomUUID;
    }

    get stats(): DeliveryStats {
        return {
            queued: this.#queue.length,
            delivered: this.#delivered,
            deadLettered: this.#deadLettered,
            retries: this.#retries,
        };
    }

    get closed(): boolean {
        return this.#closing;
    }

    /**
     * Signs a batch and queues it.
     *
     * The signature is computed here, once, and reused byte for byte on every retry:
     * `t` inside the MAC is the moment of *signing*, so a receiver's replay window
     * applies to the original send rather than restarting with each attempt.
     */
    enqueue(events: readonly WebhookEvent[]): void {
        if (events.length === 0) return;

        if (this.#closing) {
            this.#deadLetter({ reason: 'shutdown', events, attempts: 0, detail: 'the forwarder is shutting down' });
            return;
        }

        let body: string;
        try {
            body = encodeEnvelope(buildEnvelope(this.#instanceId, events));
        } catch (error) {
            // Never sent, so there is no delivery to attach. A truncated event is worse
            // than a reported one.
            this.#deadLetter({ reason: 'encode', events, attempts: 0, detail: describeError(error) });
            return;
        }

        if (this.#queue.length >= this.#config.maxQueue) {
            // The newest is refused rather than the oldest evicted: the receiver is
            // mid-stream, and dropping from the front would leave it a hole it cannot
            // see. The dead letter is where the caller learns it is falling behind.
            this.#deadLetter({
                reason: 'overflow',
                events,
                attempts: 0,
                detail: `the delivery queue is full (${this.#config.maxQueue} pending)`,
            });
            return;
        }

        const t = Math.floor(this.#now() / 1000);
        this.#queue.push({
            id: this.#newId(),
            t,
            body,
            signature: signPayload(this.#config.secret, body, t).header,
            events,
            attempts: 0,
        });

        void this.#pump();
    }

    /** Resolves once the queue is empty and nothing is in flight. */
    async idle(): Promise<void> {
        if (!this.#pumping && this.#queue.length === 0) return;
        return new Promise((resolve) => this.#idleWaiters.add(resolve));
    }

    /**
     * Stops accepting work and gives what is already queued `drainTimeoutMs` to land.
     *
     * The grace is a deadline rather than a cancellation: a delivery mid-backoff still
     * gets its next attempt if there is time for it. When the deadline passes the
     * in-flight request is aborted and everything still pending is dead-lettered, so
     * shutdown is bounded no matter how unreachable the receiver is.
     */
    async close(): Promise<void> {
        if (this.#closing) return this.idle();
        this.#closing = true;
        const grace = Math.max(0, this.#config.drainTimeoutMs);
        this.#deadline = this.#now() + grace;

        if (grace === 0) {
            this.#expire();
            return this.idle();
        }

        const timer = setTimeout(() => this.#expire(), grace);
        timer.unref?.();
        try {
            await this.idle();
        } finally {
            clearTimeout(timer);
        }
    }

    /** Cuts the shutdown grace short: abort what is in flight and stop waiting. */
    #expire(): void {
        this.#deadline = 0;
        this.#inflight?.abort();
        this.#wake();
        // Nothing is running -- close() was called on an idle-but-queued queue, or the
        // pump has already exited. Flush here, since no loop will.
        if (!this.#pumping) this.#flush();
    }

    #expired(): boolean {
        return this.#deadline !== undefined && this.#now() >= this.#deadline;
    }

    #flush(): void {
        while (this.#queue.length > 0) {
            const delivery = this.#queue.shift()!;
            this.#deadLetter({
                reason: 'shutdown',
                events: delivery.events,
                attempts: delivery.attempts,
                delivery,
                detail: 'shutdown grace expired with the delivery still pending',
            });
        }
        this.#settleIdle();
    }

    async #pump(): Promise<void> {
        if (this.#pumping) return;
        this.#pumping = true;

        try {
            while (this.#queue.length > 0) {
                if (this.#expired()) {
                    this.#flush();
                    break;
                }

                const delivery = this.#queue[0]!;
                const letter = await this.#deliver(delivery);
                this.#queue.shift();

                if (letter === null) this.#delivered += 1;
                else this.#deadLetter(letter);
            }
        } finally {
            this.#pumping = false;
            this.#settleIdle();
        }
    }

    /** Retries until the schedule, the receiver or the shutdown deadline says stop. */
    async #deliver(delivery: Delivery): Promise<DeadLetter | null> {
        const { retry } = this.#config;

        for (;;) {
            if (this.#expired()) {
                return {
                    reason: 'shutdown',
                    events: delivery.events,
                    attempts: delivery.attempts,
                    delivery,
                    detail: 'shutdown grace expired with the delivery still pending',
                };
            }

            delivery.attempts += 1;
            const result = await this.#post(delivery);

            if (result.ok) return null;

            if (!result.retryable) {
                // A 4xx that is not 408 or 429 is the receiver refusing the content. It
                // will refuse it again, and retrying only delays the events behind it.
                return {
                    reason: 'rejected',
                    events: delivery.events,
                    attempts: delivery.attempts,
                    delivery,
                    ...(result.status === undefined ? {} : { status: result.status }),
                    detail: result.detail,
                };
            }

            if (delivery.attempts >= retry.maxAttempts) {
                return {
                    reason: 'exhausted',
                    events: delivery.events,
                    attempts: delivery.attempts,
                    delivery,
                    ...(result.status === undefined ? {} : { status: result.status }),
                    detail: result.detail,
                };
            }

            this.#retries += 1;
            this.#logger.warn(
                { delivery: delivery.id, attempt: delivery.attempts, status: result.status, detail: result.detail },
                'webhook delivery failed, retrying'
            );

            // Retry-After wins over the computed delay: the receiver knows when it will
            // be ready and we do not.
            await this.#sleep(result.retryAfterMs ?? backoffDelay(delivery.attempts, retry, this.#random));
        }
    }

    async #post(
        delivery: Delivery
    ): Promise<{ ok: boolean; retryable: boolean; status?: number; detail?: string; retryAfterMs?: number }> {
        const controller = new AbortController();
        this.#inflight = controller;
        const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
        timer.unref?.();

        try {
            const response = await this.#fetch(this.#config.url, {
                method: 'POST',
                headers: {
                    ...this.#config.headers,
                    // Ours last: a custom header must not be able to overwrite the
                    // signature the receiver authenticates on.
                    'content-type': 'application/json',
                    'user-agent': USER_AGENT,
                    [INSTANCE_HEADER]: this.#instanceId,
                    [DELIVERY_HEADER]: delivery.id,
                    [SIGNATURE_HEADER]: delivery.signature,
                },
                body: delivery.body,
                signal: controller.signal,
            });

            if (response.ok) return { ok: true, retryable: false, status: response.status };

            const retryable = isRetryableStatus(response.status);
            const retryAfterMs = retryable
                ? parseRetryAfter(response.headers.get('retry-after'), this.#now())
                : undefined;

            return {
                ok: false,
                retryable,
                status: response.status,
                detail: `the receiver answered ${response.status}`,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            };
        } catch (error) {
            // A transport error, an abort on timeout, or an abort on shutdown. All three
            // are retryable; the shutdown deadline is what stops the loop, not this.
            return { ok: false, retryable: true, detail: describeError(error) };
        } finally {
            clearTimeout(timer);
            this.#inflight = undefined;
        }
    }

    /** Interruptible: shutdown wakes it so a long backoff cannot outlive the process. */
    async #sleep(ms: number): Promise<void> {
        if (ms <= 0) return;
        return new Promise<void>((resolve) => {
            const done = () => {
                this.#sleeper = undefined;
                resolve();
            };
            const timer = setTimeout(done, ms);
            timer.unref?.();
            this.#sleeper = { resolve: done, timer };
        });
    }

    #wake(): void {
        const sleeper = this.#sleeper;
        if (sleeper === undefined) return;
        clearTimeout(sleeper.timer);
        sleeper.resolve();
    }

    #deadLetter(letter: DeadLetter): void {
        this.#deadLettered += 1;
        this.#logger.error(
            { reason: letter.reason, events: letter.events.length, status: letter.status, detail: letter.detail },
            'webhook delivery dead-lettered'
        );

        if (this.#onDeadLetter === undefined) return;

        try {
            const result = this.#onDeadLetter(letter);
            // A rejecting handler must not become an unhandled rejection: this is the
            // path a caller uses to persist events, and it runs while things are
            // already going wrong.
            if (result instanceof Promise) {
                result.catch((error: unknown) => {
                    this.#logger.error({ err: error }, 'onDeadLetter failed');
                });
            }
        } catch (error) {
            this.#logger.error({ err: error }, 'onDeadLetter failed');
        }
    }

    #settleIdle(): void {
        if (this.#pumping || this.#queue.length > 0) return;
        for (const resolve of this.#idleWaiters) resolve();
        this.#idleWaiters.clear();
    }
}
