import { afterEach, describe, expect, it, vi } from 'vitest';

import { SPEC_VERSION } from '../../src/generated/index.js';
import {
    DeliveryQueue,
    isRetryableStatus,
    parseRetryAfter,
    type DeadLetter,
    type DeliveryConfig,
    type FetchLike,
    type WebhookRequestInit,
    type WebhookResponse,
} from '../../src/webhook/delivery.js';
import type { WebhookEvent } from '../../src/webhook/envelope.js';
import { verifySignature } from '../../src/webhook/signature.js';

const SECRET = 'whsec_test';
const URL = 'https://receiver.test/hook';

const config = (over: Partial<DeliveryConfig> = {}): DeliveryConfig => ({
    url: URL,
    secret: SECRET,
    timeoutMs: 1000,
    maxQueue: 10,
    drainTimeoutMs: 1000,
    // Sub-millisecond backoff: the schedule is tested by the backoff vectors, and the
    // queue only has to prove it waits between attempts.
    retry: { maxAttempts: 3, baseMs: 1, capMs: 2, floorMs: 0 },
    headers: {},
    ...over,
});

const events = (count = 1): WebhookEvent[] =>
    Array.from({ length: count }, (_, i) => ({
        event: 'session.state',
        sessionId: `s${i}`,
        ts: 1_755_500_000_000,
        data: { from: 'connecting', to: 'open' },
    }));

const respond = (status: number, headers: Record<string, string> = {}): WebhookResponse => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

interface Recorder {
    readonly fetch: FetchLike;
    readonly calls: WebhookRequestInit[];
    readonly urls: string[];
}

/** `script` is called with the 1-based attempt number. */
function recorder(script: (attempt: number) => WebhookResponse | Promise<WebhookResponse>): Recorder {
    const calls: WebhookRequestInit[] = [];
    const urls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
        urls.push(url);
        calls.push(init);
        return script(calls.length);
    };
    return { fetch, calls, urls };
}

const ok = () => respond(200);

function collector(): { onDeadLetter: (letter: DeadLetter) => void; letters: DeadLetter[] } {
    const letters: DeadLetter[] = [];
    return { onDeadLetter: (letter) => void letters.push(letter), letters };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('the request', () => {
    it('posts the signed envelope to the configured url', async () => {
        const rec = recorder(ok);
        const queue = new DeliveryQueue({ instanceId: 'host:1:abc', config: config(), fetch: rec.fetch });

        queue.enqueue(events());
        await queue.idle();

        expect(rec.urls).toEqual([URL]);
        const [call] = rec.calls;
        expect(call?.method).toBe('POST');
        expect(JSON.parse(call!.body)).toMatchObject({ specVersion: SPEC_VERSION, instanceId: 'host:1:abc' });
    });

    it('signs what it sends, over the exact bytes', async () => {
        const rec = recorder(ok);
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch: rec.fetch });

        queue.enqueue(events());
        await queue.idle();

        const call = rec.calls[0]!;
        expect(
            verifySignature({ body: call.body, header: call.headers['x-whatsmulti-signature']!, secret: SECRET })
        ).toBe(true);
    });

    it('carries the headers the spec names', async () => {
        const rec = recorder(ok);
        const queue = new DeliveryQueue({
            instanceId: 'host:1:abc',
            config: config(),
            fetch: rec.fetch,
            newId: () => 'delivery-1',
        });

        queue.enqueue(events());
        await queue.idle();

        expect(rec.calls[0]?.headers).toMatchObject({
            'content-type': 'application/json',
            'user-agent': `WhatsMulti/${SPEC_VERSION}`,
            'x-whatsmulti-instance': 'host:1:abc',
            'x-whatsmulti-delivery': 'delivery-1',
        });
    });

    it('merges custom headers but never lets them shadow the signature', async () => {
        const rec = recorder(ok);
        const queue = new DeliveryQueue({
            instanceId: 'i',
            config: config({ headers: { authorization: 'Bearer x', 'x-whatsmulti-signature': 'forged' } }),
            fetch: rec.fetch,
        });

        queue.enqueue(events());
        await queue.idle();

        expect(rec.calls[0]?.headers['authorization']).toBe('Bearer x');
        expect(rec.calls[0]?.headers['x-whatsmulti-signature']).not.toBe('forged');
    });

    it('ignores an empty batch', async () => {
        const rec = recorder(ok);
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch: rec.fetch });

        queue.enqueue([]);
        await queue.idle();

        expect(rec.calls).toEqual([]);
    });
});

describe('retrying', () => {
    it('retries a 5xx and reports success once it lands', async () => {
        const rec = recorder((attempt) => (attempt < 3 ? respond(503) : respond(200)));
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch: rec.fetch });

        queue.enqueue(events());
        await queue.idle();

        expect(rec.calls).toHaveLength(3);
        expect(queue.stats).toMatchObject({ delivered: 1, deadLettered: 0, retries: 2, queued: 0 });
    });

    it.each([408, 429, 500, 502, 503, 504])('retries %i', async (status) => {
        const rec = recorder((attempt) => (attempt === 1 ? respond(status) : respond(200)));
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch: rec.fetch });

        queue.enqueue(events());
        await queue.idle();

        expect(rec.calls).toHaveLength(2);
    });

    it.each([400, 401, 403, 404, 410, 422])('does not retry %i', async (status) => {
        // The receiver rejected the content and will keep rejecting it. Retrying only
        // delays every event queued behind it.
        const rec = recorder(() => respond(status));
        const dead = collector();
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch: rec.fetch, ...dead });

        queue.enqueue(events());
        await queue.idle();

        expect(rec.calls).toHaveLength(1);
        expect(dead.letters[0]).toMatchObject({ reason: 'rejected', status, attempts: 1 });
    });

    it('retries a transport error', async () => {
        const rec = recorder((attempt) => {
            if (attempt === 1) throw new Error('ECONNREFUSED');
            return respond(200);
        });
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch: rec.fetch });

        queue.enqueue(events());
        await queue.idle();

        expect(queue.stats).toMatchObject({ delivered: 1, retries: 1 });
    });

    it('dead-letters once the schedule is exhausted', async () => {
        const rec = recorder(() => respond(500));
        const dead = collector();
        const queue = new DeliveryQueue({
            instanceId: 'i',
            config: config({ retry: { maxAttempts: 2, baseMs: 1, capMs: 2, floorMs: 0 } }),
            fetch: rec.fetch,
            ...dead,
        });

        queue.enqueue(events());
        await queue.idle();

        expect(rec.calls).toHaveLength(2);
        expect(dead.letters[0]).toMatchObject({ reason: 'exhausted', status: 500, attempts: 2 });
        expect(dead.letters[0]?.events).toHaveLength(1);
    });

    it('reuses the delivery id, the timestamp and the bytes across retries', async () => {
        // The receiver's idempotency key has to survive a retry, and `t` is inside the
        // MAC: re-signing would move the replay window to the last attempt.
        const rec = recorder((attempt) => (attempt < 3 ? respond(500) : respond(200)));
        let clock = 1_755_500_000_000;
        const queue = new DeliveryQueue({
            instanceId: 'i',
            config: config(),
            fetch: rec.fetch,
            now: () => (clock += 5_000),
        });

        queue.enqueue(events());
        await queue.idle();

        const ids = new Set(rec.calls.map((c) => c.headers['x-whatsmulti-delivery']));
        const signatures = new Set(rec.calls.map((c) => c.headers['x-whatsmulti-signature']));
        const bodies = new Set(rec.calls.map((c) => c.body));
        expect(ids.size).toBe(1);
        expect(signatures.size).toBe(1);
        expect(bodies.size).toBe(1);
    });

    it('waits for Retry-After instead of the computed delay', async () => {
        const rec = recorder((attempt) => (attempt === 1 ? respond(503, { 'retry-after': '1' }) : respond(200)));
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch: rec.fetch });

        const started = Date.now();
        queue.enqueue(events());
        // Backoff alone would be under 2ms here, so anything near a second is the
        // header being honoured.
        const settled = queue.idle().then(() => Date.now() - started);
        await vi.waitFor(() => expect(rec.calls).toHaveLength(1));
        expect(await settled).toBeGreaterThanOrEqual(900);
    }, 10_000);

    it('ignores Retry-After on a status it would not retry anyway', async () => {
        const rec = recorder(() => respond(400, { 'retry-after': '3600' }));
        const dead = collector();
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch: rec.fetch, ...dead });

        queue.enqueue(events());
        await queue.idle();

        expect(dead.letters[0]?.reason).toBe('rejected');
    });

    it('aborts a request that outruns the timeout, and retries it', async () => {
        let attempts = 0;
        const fetch: FetchLike = (_url, init) => {
            attempts += 1;
            if (attempts > 1) return Promise.resolve(respond(200));
            return new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => reject(new Error('aborted')));
            });
        };
        const queue = new DeliveryQueue({ instanceId: 'i', config: config({ timeoutMs: 20 }), fetch });

        queue.enqueue(events());
        await queue.idle();

        expect(attempts).toBe(2);
        expect(queue.stats).toMatchObject({ delivered: 1, retries: 1 });
    });
});

describe('ordering and backpressure', () => {
    it('posts one delivery at a time, in order', async () => {
        // Parallel posts with independent retries would let a receiver see `open`
        // before the `qr` that preceded it.
        let inflight = 0;
        const order: string[] = [];
        const fetch: FetchLike = async (_url, init) => {
            inflight += 1;
            expect(inflight).toBe(1);
            order.push((JSON.parse(init.body) as { events: WebhookEvent[] }).events[0]!.sessionId);
            await new Promise((resolve) => setTimeout(resolve, 1));
            inflight -= 1;
            return respond(200);
        };
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch });

        for (let i = 0; i < 5; i += 1) queue.enqueue([{ ...events()[0]!, sessionId: `s${i}` }]);
        await queue.idle();

        expect(order).toEqual(['s0', 's1', 's2', 's3', 's4']);
    });

    it('refuses the newest delivery when the queue is full', async () => {
        // Dropping from the front would leave the receiver a hole it cannot see; the
        // dead letter is where the caller learns it is falling behind.
        let release = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        const fetch: FetchLike = async () => {
            await gate;
            return respond(200);
        };
        const dead = collector();
        const queue = new DeliveryQueue({ instanceId: 'i', config: config({ maxQueue: 2 }), fetch, ...dead });

        for (let i = 0; i < 5; i += 1) queue.enqueue([{ ...events()[0]!, sessionId: `s${i}` }]);
        // The bound covers the delivery in flight too: it stays at the head of the
        // queue until it is done, because a retry must not lose its place.
        expect(dead.letters.map((l) => l.reason)).toEqual(['overflow', 'overflow', 'overflow']);
        expect(dead.letters[0]?.events[0]?.sessionId).toBe('s2');

        release();
        await queue.idle();
        expect(queue.stats.delivered).toBe(2);
    });

    it('reports the queue depth', async () => {
        let release = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        const fetch: FetchLike = async () => {
            await gate;
            return respond(200);
        };
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch });

        queue.enqueue(events());
        queue.enqueue(events());
        expect(queue.stats.queued).toBe(2);

        release();
        await queue.idle();
        expect(queue.stats.queued).toBe(0);
    });

    it('resolves idle immediately when there is nothing to do', async () => {
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch: recorder(ok).fetch });
        await expect(queue.idle()).resolves.toBeUndefined();
    });
});

describe('payloads that cannot be sent', () => {
    it('dead-letters an unserialisable payload without posting it', async () => {
        const rec = recorder(ok);
        const dead = collector();
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch: rec.fetch, ...dead });

        const cycle: Record<string, unknown> = {};
        cycle['self'] = cycle;
        queue.enqueue([{ event: 'session.state', sessionId: 's', ts: 1, data: cycle }]);
        await queue.idle();

        expect(rec.calls).toEqual([]);
        expect(dead.letters[0]).toMatchObject({ reason: 'encode', attempts: 0 });
        expect(dead.letters[0]?.delivery).toBeUndefined();
    });
});

describe('shutdown', () => {
    it('drains what is queued', async () => {
        const rec = recorder(ok);
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch: rec.fetch });

        queue.enqueue(events());
        queue.enqueue(events());
        await queue.close();

        expect(rec.calls).toHaveLength(2);
        expect(queue.stats).toMatchObject({ delivered: 2, deadLettered: 0 });
        expect(queue.closed).toBe(true);
    });

    it('dead-letters everything pending when there is no grace at all', async () => {
        let release = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        const fetch: FetchLike = async (_url, init) => {
            await Promise.race([
                gate,
                new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
            ]);
            return respond(200);
        };
        const dead = collector();
        const queue = new DeliveryQueue({
            instanceId: 'i',
            config: config({ drainTimeoutMs: 0 }),
            fetch,
            ...dead,
        });

        queue.enqueue(events());
        queue.enqueue(events());
        await queue.close();
        release();

        expect(dead.letters.map((l) => l.reason)).toEqual(['shutdown', 'shutdown']);
        expect(dead.letters[0]?.delivery).toBeDefined();
    });

    it('aborts the request in flight once the grace expires', async () => {
        let aborted = false;
        const fetch: FetchLike = (_url, init) =>
            new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                    aborted = true;
                    reject(new Error('aborted'));
                });
            });
        const dead = collector();
        const queue = new DeliveryQueue({
            instanceId: 'i',
            config: config({ drainTimeoutMs: 20, timeoutMs: 60_000 }),
            fetch,
            ...dead,
        });

        queue.enqueue(events());
        await queue.close();

        expect(aborted).toBe(true);
        expect(dead.letters[0]?.reason).toBe('shutdown');
    });

    it('cuts a backoff sleep short rather than outliving the process', async () => {
        const rec = recorder(() => respond(503, { 'retry-after': '3600' }));
        const dead = collector();
        const queue = new DeliveryQueue({
            instanceId: 'i',
            config: config({ drainTimeoutMs: 20 }),
            fetch: rec.fetch,
            ...dead,
        });

        queue.enqueue(events());
        await vi.waitFor(() => expect(rec.calls).toHaveLength(1));
        await queue.close();

        expect(dead.letters[0]?.reason).toBe('shutdown');
    }, 10_000);

    it('refuses new work once closed', async () => {
        const rec = recorder(ok);
        const dead = collector();
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch: rec.fetch, ...dead });

        await queue.close();
        queue.enqueue(events());

        expect(rec.calls).toEqual([]);
        expect(dead.letters[0]).toMatchObject({ reason: 'shutdown', attempts: 0 });
    });

    it('is idempotent', async () => {
        const queue = new DeliveryQueue({ instanceId: 'i', config: config(), fetch: recorder(ok).fetch });
        await queue.close();
        await expect(queue.close()).resolves.toBeUndefined();
    });
});

describe('the dead letter callback', () => {
    it('survives a handler that throws', async () => {
        const queue = new DeliveryQueue({
            instanceId: 'i',
            config: config(),
            fetch: recorder(() => respond(400)).fetch,
            onDeadLetter: () => {
                throw new Error('handler exploded');
            },
        });

        queue.enqueue(events());
        await expect(queue.idle()).resolves.toBeUndefined();
        expect(queue.stats.deadLettered).toBe(1);
    });

    it('survives a handler that rejects', async () => {
        // This runs while things are already going wrong; an unhandled rejection here
        // takes the process down by default.
        const queue = new DeliveryQueue({
            instanceId: 'i',
            config: config(),
            fetch: recorder(() => respond(400)).fetch,
            onDeadLetter: () => Promise.reject(new Error('async explosion')),
        });

        queue.enqueue(events());
        await queue.idle();
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(queue.stats.deadLettered).toBe(1);
    });

    it('is optional', async () => {
        const queue = new DeliveryQueue({
            instanceId: 'i',
            config: config(),
            fetch: recorder(() => respond(400)).fetch,
        });

        queue.enqueue(events());
        await expect(queue.idle()).resolves.toBeUndefined();
    });
});

describe('isRetryableStatus', () => {
    it.each([408, 429, 500, 599, 503])('%i is worth retrying', (status) => {
        expect(isRetryableStatus(status)).toBe(true);
    });

    it.each([200, 301, 400, 401, 403, 404, 422, 499])('%i is not', (status) => {
        expect(isRetryableStatus(status)).toBe(false);
    });
});

describe('parseRetryAfter', () => {
    const now = 1_755_500_000_000;

    it('reads delta-seconds', () => {
        expect(parseRetryAfter('120', now)).toBe(120_000);
        expect(parseRetryAfter(' 5 ', now)).toBe(5_000);
        expect(parseRetryAfter('0', now)).toBe(0);
    });

    it('reads an HTTP-date', () => {
        expect(parseRetryAfter(new Date(now + 30_000).toUTCString(), now)).toBe(30_000);
    });

    it('floors a date already in the past at zero', () => {
        expect(parseRetryAfter(new Date(now - 60_000).toUTCString(), now)).toBe(0);
    });

    it.each([
        [null, 'absent'],
        ['', 'empty'],
        ['   ', 'blank'],
        ['soon', 'unparseable'],
        ['-5', 'negative'],
    ])('returns undefined for %s (%s)', (value, _label) => {
        expect(parseRetryAfter(value, now)).toBeUndefined();
    });
});

describe('the default transport', () => {
    it('accepts the global fetch', () => {
        // Typing only: this is what keeps the structural FetchLike honest against the
        // real thing.
        const real: FetchLike = globalThis.fetch;
        expect(typeof real).toBe('function');
    });
});
