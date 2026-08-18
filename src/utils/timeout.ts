/**
 * A deadline around a promise.
 *
 * The wrapped work is **not** cancelled -- JavaScript promises cannot be. A timeout
 * returns control to the caller and nothing more, so an operation with a side effect
 * may still complete after its deadline passed. That is why the message says the
 * operation timed out rather than that it failed.
 */
import { WhatsMultiError } from '../errors.js';

export interface TimeoutOptions {
    /** Named in the error, so a timeout says which call gave up. */
    readonly operation: string;
    readonly timeoutMs: number;
    readonly sessionId?: string | undefined;
}

export async function withTimeout<T>(work: Promise<T>, options: TimeoutOptions): Promise<T> {
    if (options.timeoutMs <= 0) return work;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(
                new WhatsMultiError('TIMEOUT', {
                    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
                    params: { operation: options.operation, timeoutMs: options.timeoutMs },
                })
            );
        }, options.timeoutMs);
    });

    try {
        return await Promise.race([work, deadline]);
    } finally {
        // Cleared whichever way the race went, so a pending timer cannot hold the
        // process open past a send that already returned.
        if (timer !== undefined) clearTimeout(timer);
    }
}
