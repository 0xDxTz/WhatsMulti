/**
 * A bounded, rate-limited work queue, one per session.
 *
 * Sends are serialised by default because two in flight at once mutate the same
 * Signal session state concurrently, and the loser of that race produces a message
 * the recipient cannot decrypt. Serialising also gives us the one place where rate
 * limiting belongs -- v1 had neither, and sent straight from the caller's stack.
 *
 * The queue itself knows nothing about messages: it is scheduling and backpressure,
 * which is what makes it testable without a socket.
 */
import type { SendConfig } from '../config.js';
import { WhatsMultiError } from '../errors.js';

export interface SendQueueOptions {
    readonly sessionId: string;
    readonly config: SendConfig;
    /** Injected in tests. Defaults to the real clock. */
    readonly now?: (() => number) | undefined;
    readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

interface Job {
    readonly run: () => Promise<void>;
    readonly reject: (error: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class SendQueue {
    readonly #sessionId: string;
    readonly #config: SendConfig;
    readonly #now: () => number;
    readonly #sleep: (ms: number) => Promise<void>;

    readonly #waiting: Job[] = [];
    #running = 0;
    #lastStart = Number.NEGATIVE_INFINITY;
    #closed = false;
    readonly #idle = new Set<() => void>();

    constructor(options: SendQueueOptions) {
        this.#sessionId = options.sessionId;
        this.#config = options.config;
        this.#now = options.now ?? Date.now;
        this.#sleep = options.sleep ?? defaultSleep;
    }

    /** Tasks waiting for a slot. This is the backpressure signal. */
    get size(): number {
        return this.#waiting.length;
    }

    /** Tasks currently executing. */
    get running(): number {
        return this.#running;
    }

    get idle(): boolean {
        return this.#running === 0 && this.#waiting.length === 0;
    }

    get closed(): boolean {
        return this.#closed;
    }

    /**
     * Queues a task and resolves with its result.
     *
     * Rejects immediately with SEND_FAILED once `maxQueue` tasks are already waiting.
     * Refusing is the point: an unbounded queue turns a backend that has stopped
     * accepting messages into an out-of-memory crash, and the caller never learns
     * anything is wrong.
     */
    async push<T>(task: () => Promise<T>): Promise<T> {
        if (this.#closed) throw this.#failed('the send queue is closed');

        if (this.#waiting.length >= this.#config.maxQueue) {
            throw this.#failed(`the send queue is full (${this.#config.maxQueue} waiting)`);
        }

        return new Promise<T>((resolve, reject) => {
            this.#waiting.push({
                reject,
                run: async () => {
                    try {
                        resolve(await task());
                    } catch (error) {
                        // Whatever the task threw is passed through untouched. Wrapping
                        // it here would bury the driver's own error, which is the only
                        // thing that says why a send failed.
                        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                        reject(error);
                    }
                },
            });
            void this.#pump();
        });
    }

    /** Resolves once everything queued and running has finished. */
    async drain(): Promise<void> {
        if (this.idle) return;
        return new Promise((resolve) => this.#idle.add(resolve));
    }

    /**
     * Rejects everything still waiting and refuses new work.
     *
     * Tasks already running are left alone: a send that has reached the socket has
     * possibly already been delivered, and rejecting its promise would tell the
     * caller it failed when it did not.
     */
    close(reason?: WhatsMultiError): void {
        this.#closed = true;
        const error = reason ?? this.#failed('the session stopped before the send started');

        while (this.#waiting.length > 0) this.#waiting.shift()?.reject(error);
        this.#settleIdle();
    }

    #failed(detail: string): WhatsMultiError {
        return new WhatsMultiError('SEND_FAILED', {
            sessionId: this.#sessionId,
            params: { sessionId: this.#sessionId, detail },
        });
    }

    async #pump(): Promise<void> {
        if (this.#running >= this.#config.concurrency) return;

        const job = this.#waiting.shift();
        if (job === undefined) return;

        this.#running += 1;

        // Measured between starts, not between finishes: a gap enforced after the
        // previous task returned would stretch with every slow send, which is the
        // opposite of a rate limit. The slot is reserved before awaiting so that
        // concurrent workers stagger instead of all waking at the same instant.
        const start = Math.max(this.#now(), this.#lastStart + this.#config.minDelayMs);
        this.#lastStart = start;
        const wait = start - this.#now();
        if (wait > 0) await this.#sleep(wait);

        try {
            await job.run();
        } finally {
            this.#running -= 1;
            if (this.#waiting.length > 0) void this.#pump();
            else this.#settleIdle();
        }
    }

    #settleIdle(): void {
        if (!this.idle) return;
        for (const resolve of this.#idle) resolve();
        this.#idle.clear();
    }
}
