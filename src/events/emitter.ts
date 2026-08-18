import { EventEmitter } from 'node:events';

import { describeError, formatErrorMessage, isWhatsMultiError } from '../errors.js';
import { silentLogger, type Logger } from '../logger.js';
import type {
    EventBatch,
    EventBatchListener,
    EventListener,
    EventMap,
    EventMeta,
    EventName,
    SessionErrorEvent,
} from './types.js';

const ERROR_EVENT = 'session.error';

export interface EmitterOptions {
    readonly logger?: Logger | undefined;
    /**
     * Node warns past 10 listeners. Multi-session consumers legitimately attach more
     * than that, but unlimited would hide a real leak.
     */
    readonly maxListeners?: number | undefined;
}

/**
 * Typed event bus.
 *
 * Two properties matter beyond the typing:
 *
 * 1. A listener that throws, or returns a rejecting promise, cannot take the process
 *    down. v1 invoked async listeners bare, so any rejection became an unhandled
 *    rejection -- fatal on Node by default.
 * 2. There is no `'error'` event name. Node's EventEmitter *throws* when `'error'`
 *    is emitted with no listener attached, which turns a reporting path into a crash
 *    path. Failures surface as `session.error` instead.
 */
export class WMEventEmitter {
    readonly #emitter = new EventEmitter();
    readonly #wrappers = new WeakMap<object, Map<string, (...args: unknown[]) => void>>();
    readonly #batchListeners = new Set<EventBatchListener>();
    #logger: Logger;

    constructor(options: EmitterOptions = {}) {
        this.#logger = options.logger ?? silentLogger;
        this.#emitter.setMaxListeners(options.maxListeners ?? 50);
    }

    setLogger(logger: Logger): void {
        this.#logger = logger;
    }

    on<K extends EventName>(event: K, listener: EventListener<K>): this {
        this.#emitter.on(event as string, this.#wrap(event, listener, false));
        return this;
    }

    once<K extends EventName>(event: K, listener: EventListener<K>): this {
        this.#emitter.on(event as string, this.#wrap(event, listener, true));
        return this;
    }

    off<K extends EventName>(event: K, listener: EventListener<K>): this {
        const wrapper = this.#wrappers.get(listener as object)?.get(event as string);
        if (wrapper) {
            this.#emitter.off(event as string, wrapper);
            this.#wrappers.get(listener as object)?.delete(event as string);
        }
        return this;
    }

    removeAllListeners(event?: EventName): this {
        if (event === undefined) {
            this.#emitter.removeAllListeners();
            this.#batchListeners.clear();
        } else {
            this.#emitter.removeAllListeners(event as string);
        }
        return this;
    }

    listenerCount(event: EventName): number {
        return this.#emitter.listenerCount(event as string);
    }

    /** Catch-all. Returns an unsubscribe function. */
    process(listener: EventBatchListener): () => void {
        this.#batchListeners.add(listener);
        return () => this.#batchListeners.delete(listener);
    }

    /** Emits a single event. Batch listeners see it as a batch of one. */
    emit<K extends EventName>(event: K, data: EventMap[K], meta: EventMeta): void {
        this.emitBatch({ [event]: data } as EventBatch, meta);
    }

    /**
     * Fans a driver batch out to per-event listeners, then hands the batch to
     * `process()` listeners unchanged.
     */
    emitBatch(events: EventBatch, meta: EventMeta): void {
        for (const [event, data] of Object.entries(events)) {
            if (data === undefined) continue;
            this.#emitter.emit(event, data, meta);
        }

        for (const listener of this.#batchListeners) {
            this.#guard(() => listener(events, meta), 'process', meta);
        }
    }

    #wrap<K extends EventName>(event: K, listener: EventListener<K>, once: boolean) {
        const existing = this.#wrappers.get(listener as object);
        const cached = existing?.get(event as string);
        if (cached) return cached;

        const wrapper = (...args: unknown[]) => {
            const [data, meta] = args as [EventMap[K], EventMeta];
            if (once) this.off(event, listener);
            this.#guard(() => listener(data, meta), event as string, meta);
        };

        const map = existing ?? new Map<string, (...args: unknown[]) => void>();
        map.set(event as string, wrapper);
        this.#wrappers.set(listener as object, map);
        return wrapper;
    }

    /** Runs a listener so that neither a throw nor a rejection escapes. */
    #guard(run: () => unknown, source: string, meta: EventMeta): void {
        try {
            const result = run();
            if (result instanceof Promise) {
                result.catch((error: unknown) => this.#report(error, source, meta));
            }
        } catch (error) {
            this.#report(error, source, meta);
        }
    }

    #report(error: unknown, source: string, meta: EventMeta): void {
        this.#logger.error({ err: error, source, sessionId: meta.sessionId }, 'event listener failed');

        // Reporting a failed session.error listener as session.error would recurse.
        if (source === ERROR_EVENT) return;

        this.#emitError(error, source, meta);
    }

    #emitError(error: unknown, source: string, meta: EventMeta): void {
        // A listener that throws is not itself one of our failure modes, so an
        // arbitrary throw is reported under LISTENER_FAILED rather than being
        // mislabelled with whichever code happens to be nearby.
        const payload: SessionErrorEvent = isWhatsMultiError(error)
            ? { code: error.code, message: error.message }
            : {
                  code: 'LISTENER_FAILED',
                  message: formatErrorMessage('LISTENER_FAILED', { event: source, detail: describeError(error) }),
              };

        // Emitted directly rather than through emitBatch: a process() listener must
        // not be re-entered while we are handling its own failure.
        this.#emitter.emit(ERROR_EVENT, payload, meta);
    }
}
