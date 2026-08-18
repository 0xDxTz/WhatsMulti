import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, type SendConfig } from '../../src/config.js';
import { WhatsMultiError } from '../../src/errors.js';
import { SendQueue } from '../../src/messaging/queue.js';

const send = (overrides: Partial<SendConfig> = {}): SendConfig => ({ ...DEFAULT_CONFIG.send, ...overrides });

/** A virtual clock, so rate limiting is asserted exactly rather than by sleeping. */
function clock() {
    let time = 1000;
    const sleeps: number[] = [];
    return {
        sleeps,
        now: () => time,
        sleep: (ms: number) => {
            sleeps.push(ms);
            time += ms;
            return Promise.resolve();
        },
        advance: (ms: number) => {
            time += ms;
        },
    };
}

const queue = (overrides: Partial<SendConfig> = {}, timer = clock()) =>
    new SendQueue({ sessionId: 's1', config: send(overrides), now: timer.now, sleep: timer.sleep });

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

describe('SendQueue ordering', () => {
    it('runs tasks in the order they were pushed', async () => {
        const q = queue();
        const order: number[] = [];

        await Promise.all([1, 2, 3, 4].map((n) => q.push(() => Promise.resolve(order.push(n)))));

        expect(order).toEqual([1, 2, 3, 4]);
    });

    it('runs one at a time by default', async () => {
        // Two sends in flight mutate the same Signal session state concurrently, and
        // the loser produces a message the recipient cannot decrypt.
        const q = queue();
        let live = 0;
        let peak = 0;

        await Promise.all(
            Array.from({ length: 5 }, () =>
                q.push(async () => {
                    live += 1;
                    peak = Math.max(peak, live);
                    await Promise.resolve();
                    live -= 1;
                })
            )
        );

        expect(peak).toBe(1);
    });

    it('honours a higher concurrency', async () => {
        const q = queue({ concurrency: 3 });
        const gate = deferred<void>();
        let live = 0;
        let peak = 0;

        const all = Promise.all(
            Array.from({ length: 6 }, () =>
                q.push(async () => {
                    live += 1;
                    peak = Math.max(peak, live);
                    await gate.promise;
                    live -= 1;
                })
            )
        );
        await Promise.resolve();
        gate.resolve();
        await all;

        expect(peak).toBe(3);
    });

    it('resolves with the task result and rejects with its error untouched', async () => {
        const q = queue();
        const boom = new Error('driver said no');

        await expect(q.push(() => Promise.resolve('ok'))).resolves.toBe('ok');
        await expect(q.push(() => Promise.reject(boom))).rejects.toBe(boom);
    });

    it('keeps draining after a task fails', async () => {
        const q = queue();
        const order: string[] = [];

        const failing = q
            .push(() => {
                order.push('first');
                return Promise.reject(new Error('nope'));
            })
            .catch(() => undefined);
        const next = q.push(() => Promise.resolve(order.push('second')));
        await Promise.all([failing, next]);

        expect(order).toEqual(['first', 'second']);
    });
});

describe('SendQueue rate limiting', () => {
    it('does not wait when no gap is configured', async () => {
        const timer = clock();
        const q = queue({}, timer);

        await q.push(() => Promise.resolve());
        await q.push(() => Promise.resolve());

        expect(timer.sleeps).toEqual([]);
    });

    it('enforces the gap between consecutive starts', async () => {
        const timer = clock();
        const q = queue({ minDelayMs: 250 }, timer);

        await q.push(() => Promise.resolve());
        await q.push(() => Promise.resolve());
        await q.push(() => Promise.resolve());

        expect(timer.sleeps).toEqual([250, 250]);
    });

    it('measures the gap from the previous start, not the previous finish', async () => {
        // A gap enforced after the previous task returned would stretch with every
        // slow send, which is the opposite of a rate limit.
        const timer = clock();
        const q = queue({ minDelayMs: 250 }, timer);

        await q.push(() => {
            timer.advance(200);
            return Promise.resolve();
        });
        await q.push(() => Promise.resolve());

        expect(timer.sleeps).toEqual([50]);
    });

    it('does not wait when the task already took longer than the gap', async () => {
        const timer = clock();
        const q = queue({ minDelayMs: 100 }, timer);

        await q.push(() => {
            timer.advance(500);
            return Promise.resolve();
        });
        await q.push(() => Promise.resolve());

        expect(timer.sleeps).toEqual([]);
    });

    it('staggers concurrent workers instead of waking them together', async () => {
        const timer = clock();
        const q = queue({ concurrency: 2, minDelayMs: 100 }, timer);

        await Promise.all([q.push(() => Promise.resolve()), q.push(() => Promise.resolve())]);

        expect(timer.sleeps).toEqual([100]);
    });
});

describe('SendQueue backpressure', () => {
    it('reports how many tasks are waiting', async () => {
        const q = queue();
        const gate = deferred<void>();
        const first = q.push(() => gate.promise);
        const rest = [q.push(() => Promise.resolve()), q.push(() => Promise.resolve())];

        expect(q.size).toBe(2);
        expect(q.running).toBe(1);
        expect(q.idle).toBe(false);

        gate.resolve();
        await Promise.all([first, ...rest]);
        expect(q.idle).toBe(true);
    });

    it('refuses work once the queue is full', async () => {
        // An unbounded queue turns a backend that stopped accepting messages into an
        // out-of-memory crash, and the caller never learns anything is wrong.
        const q = queue({ maxQueue: 2 });
        const gate = deferred<void>();
        const running = q.push(() => gate.promise);
        const queued = [q.push(() => Promise.resolve()), q.push(() => Promise.resolve())];

        await expect(q.push(() => Promise.resolve())).rejects.toMatchObject({ code: 'SEND_FAILED' });

        gate.resolve();
        await Promise.all([running, ...queued]);
    });

    it('names the session and the reason', async () => {
        const q = queue({ maxQueue: 1 });
        const gate = deferred<void>();
        const running = q.push(() => gate.promise);
        const queued = q.push(() => Promise.resolve());

        const error = (await q.push(() => Promise.resolve()).catch((e: unknown) => e)) as WhatsMultiError;
        expect(error.sessionId).toBe('s1');
        expect(error.message).toContain('s1');
        expect(error.message).toContain('full');

        gate.resolve();
        await Promise.all([running, queued]);
    });

    it('accepts work again once the queue drains', async () => {
        const q = queue({ maxQueue: 1 });
        const gate = deferred<void>();
        const running = q.push(() => gate.promise);
        const queued = q.push(() => Promise.resolve());
        gate.resolve();
        await Promise.all([running, queued]);

        await expect(q.push(() => Promise.resolve('later'))).resolves.toBe('later');
    });
});

describe('SendQueue.drain', () => {
    it('resolves immediately when there is nothing to do', async () => {
        await expect(queue().drain()).resolves.toBeUndefined();
    });

    it('waits for everything queued and running', async () => {
        const q = queue();
        const gate = deferred<void>();
        const done: string[] = [];
        const tasks = [
            q.push(async () => {
                await gate.promise;
                done.push('a');
            }),
            q.push(() => Promise.resolve(done.push('b'))),
        ];

        const drained = q.drain().then(() => done.push('drained'));
        gate.resolve();
        await Promise.all([...tasks, drained]);

        expect(done).toEqual(['a', 'b', 'drained']);
    });

    it('wakes every waiter', async () => {
        const q = queue();
        const gate = deferred<void>();
        const task = q.push(() => gate.promise);
        const waiters = [q.drain(), q.drain()];

        gate.resolve();
        await task;

        await expect(Promise.all(waiters)).resolves.toEqual([undefined, undefined]);
    });
});

describe('SendQueue.close', () => {
    it('rejects everything still waiting', async () => {
        const q = queue();
        const gate = deferred<void>();
        const running = q.push(() => gate.promise);
        const waiting = q.push(() => Promise.resolve('never'));

        q.close();

        await expect(waiting).rejects.toMatchObject({ code: 'SEND_FAILED' });
        gate.resolve();
        await expect(running).resolves.toBeUndefined();
    });

    it('leaves a running task alone', async () => {
        // A send that reached the socket may already have been delivered; rejecting
        // its promise would tell the caller it failed when it did not.
        const q = queue();
        const gate = deferred<string>();
        const running = q.push(() => gate.promise);

        q.close();
        gate.resolve('delivered');

        await expect(running).resolves.toBe('delivered');
    });

    it('refuses new work', async () => {
        const q = queue();
        q.close();

        await expect(q.push(() => Promise.resolve())).rejects.toMatchObject({ code: 'SEND_FAILED' });
        expect(q.closed).toBe(true);
    });

    it('accepts a caller-supplied reason', async () => {
        const q = queue();
        const gate = deferred<void>();
        const running = q.push(() => gate.promise);
        const waiting = q.push(() => Promise.resolve());
        const reason = new WhatsMultiError('SESSION_LOGGED_OUT', { params: { sessionId: 's1' } });

        q.close(reason);

        await expect(waiting).rejects.toBe(reason);
        gate.resolve();
        await running;
    });

    it('releases anyone waiting on drain once the last task finishes', async () => {
        const q = queue();
        const gate = deferred<void>();
        const running = q.push(() => gate.promise);
        const waiting = q.push(() => Promise.resolve());
        const drained = q.drain();

        q.close();
        await expect(waiting).rejects.toMatchObject({ code: 'SEND_FAILED' });

        gate.resolve();
        await running;
        await expect(drained).resolves.toBeUndefined();
    });

    it('is safe to call twice', () => {
        const q = queue();
        q.close();

        expect(() => q.close()).not.toThrow();
    });

    it('uses the real clock and timers when none are injected', async () => {
        const real = new SendQueue({ sessionId: 's1', config: send({ minDelayMs: 1 }) });
        const seen = vi.fn();

        await real.push(() => Promise.resolve(seen()));
        await real.push(() => Promise.resolve(seen()));

        expect(seen).toHaveBeenCalledTimes(2);
    });
});
