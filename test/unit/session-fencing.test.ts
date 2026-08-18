import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, type ResolvedConfig } from '../../src/config.js';
import { WMEventEmitter } from '../../src/events/emitter.js';
import { silentLogger } from '../../src/logger.js';
import { memoryLock, sessionLockKey, type LockProvider, type LockToken } from '../../src/session/lock.js';
import { Session } from '../../src/session/session.js';
import { memoryStorage } from '../../src/storage/memory.js';
import { fakeDriver } from '../fixtures/fake-socket.js';

const TTL = DEFAULT_CONFIG.lock.ttlMs;
/** spec/config.yaml#lock.renew_ratio, applied to the default TTL. */
const RENEW_AT = Math.floor(TTL * DEFAULT_CONFIG.lock.renewRatio);
const KEY = sessionLockKey('s1');

const config = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
    ...DEFAULT_CONFIG,
    instanceId: 'inst-1',
    ...overrides,
});

interface Harness {
    readonly session: Session;
    readonly driver: ReturnType<typeof fakeDriver>;
    readonly lock: LockProvider;
    of(event: string): unknown[];
}

function harness(lock: LockProvider = memoryLock(), overrides: Partial<ResolvedConfig> = {}): Harness {
    const driver = fakeDriver();
    const emitter = new WMEventEmitter();
    const seen: [string, unknown][] = [];
    emitter.process((events) => {
        for (const entry of Object.entries(events)) seen.push(entry);
    });

    const session = new Session({
        sessionId: 's1',
        storage: memoryStorage(),
        config: config(overrides),
        emitter,
        logger: silentLogger,
        lockProvider: lock,
        socketFactory: driver.factory,
    });

    return { session, driver, lock, of: (event) => seen.filter(([n]) => n === event).map(([, d]) => d) };
}

/** A provider whose renew and release can be made to fail or refuse on demand. */
function scriptedLock(inner: LockProvider = memoryLock()): LockProvider & {
    renewResult: 'ok' | 'fenced' | 'throws';
    releaseError: Error | undefined;
} {
    return {
        renewResult: 'ok',
        releaseError: undefined,
        name: 'scripted',
        acquire: (key, ttlMs, owner) => inner.acquire(key, ttlMs, owner),
        inspect: (key) => inner.inspect(key),
        renew(token, ttlMs) {
            if (this.renewResult === 'throws') return Promise.reject(new Error('backend unreachable'));
            if (this.renewResult === 'fenced') return Promise.resolve(null);
            return inner.renew(token, ttlMs);
        },
        release(token) {
            if (this.releaseError !== undefined) return Promise.reject(this.releaseError);
            return inner.release(token);
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('acquiring', () => {
    it('takes the lock before opening a socket', async () => {
        const h = harness();

        await h.session.start();

        expect(h.session.lock).toMatchObject({ key: KEY, owner: 'inst-1' });
        await expect(h.lock.inspect(KEY)).resolves.toMatchObject({ owner: 'inst-1' });
    });

    it('refuses to start when another instance holds the session', async () => {
        const lock = memoryLock();
        await lock.acquire(KEY, TTL, 'inst-2');
        const h = harness(lock);

        await expect(h.session.start()).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
        expect(h.driver.sockets).toHaveLength(0);
    });

    it('names the instance that holds it, so the operator knows where to look', async () => {
        const lock = memoryLock();
        await lock.acquire(KEY, TTL, 'inst-2');
        const h = harness(lock);

        const error = await h.session.start().catch((cause: unknown) => cause);

        expect((error as Error).message).toContain('inst-2');
    });

    it('leaves the session closed, not connecting, when the lock is refused', async () => {
        const lock = memoryLock();
        await lock.acquire(KEY, TTL, 'inst-2');
        const h = harness(lock);

        await h.session.start().catch(() => undefined);

        expect(h.session.state).toBe('closed');
    });

    it('still names an owner when the provider cannot say who holds it', async () => {
        const lock = memoryLock();
        await lock.acquire(KEY, TTL, 'inst-2');
        const blind: LockProvider = { ...lock, inspect: () => Promise.reject(new Error('down')) };
        const h = harness(blind);

        const error = await h.session.start().catch((cause: unknown) => cause);

        expect((error as Error).message).toContain('another instance');
    });

    it('does not lock at all when locking is disabled', async () => {
        const lock = memoryLock();
        await lock.acquire(KEY, TTL, 'inst-2');
        const h = harness(lock, { lock: { ...DEFAULT_CONFIG.lock, enabled: false } });

        await h.session.start();

        expect(h.session.lock).toBeUndefined();
        expect(h.driver.sockets).toHaveLength(1);
    });

    it('keeps one lock across a restart rather than taking a second', async () => {
        const h = harness();
        await h.session.start();
        const first = h.session.lock;

        await h.driver.last.close(500);
        await vi.advanceTimersByTimeAsync(5000);

        expect(h.session.lock).toMatchObject({ token: first!.token });
    });
});

describe('the heartbeat', () => {
    it('renews the lease before it lapses', async () => {
        const h = harness();
        await h.session.start();
        const before = h.session.lock!;

        await vi.advanceTimersByTimeAsync(RENEW_AT);

        expect(h.session.lock!.expiresAt).toBeGreaterThan(before.expiresAt);
        // Same acquisition, extended -- not a new one. A renew that minted a fresh
        // token would mean the lock had briefly been free.
        expect(h.session.lock!.token).toBe(before.token);
    });

    it('keeps renewing, so a long-lived session never lets the lease run out', async () => {
        const h = harness();
        await h.session.start();

        await vi.advanceTimersByTimeAsync(TTL * 4);

        await expect(h.lock.inspect(KEY)).resolves.toMatchObject({ owner: 'inst-1' });
    });

    it('retries a failing backend while the lease it already holds is still valid', async () => {
        const lock = scriptedLock();
        const h = harness(lock);
        await h.session.start();

        lock.renewResult = 'throws';
        await vi.advanceTimersByTimeAsync(RENEW_AT);

        expect(h.session.state).toBe('connecting');
        expect(h.session.lock).toBeDefined();
        expect(h.of('session.fenced')).toEqual([]);
    });

    it('fails stop once the lease it holds has lapsed and it still cannot renew', async () => {
        const lock = scriptedLock();
        const h = harness(lock);
        await h.session.start();

        lock.renewResult = 'throws';
        // Long enough that the retries run out the lease we were holding.
        await vi.advanceTimersByTimeAsync(TTL * 2);

        expect(h.of('session.fenced')).toHaveLength(1);
    });
});

describe('being fenced', () => {
    async function fenced(): Promise<Harness> {
        const lock = scriptedLock();
        const h = harness(lock);
        await h.session.start();
        await h.driver.last.open();

        // Another instance took it. The provider reports the loss on the next renew.
        await lock.release(h.session.lock!);
        await lock.acquire(KEY, TTL, 'inst-2');
        lock.renewResult = 'fenced';
        await vi.advanceTimersByTimeAsync(RENEW_AT);

        return h;
    }

    it('closes the socket at once', async () => {
        const h = await fenced();

        expect(h.driver.last.ended).toBe(true);
        expect(h.session.socket).toBeUndefined();
    });

    it('moves to closed, with fenced as the reason', async () => {
        const h = await fenced();

        expect(h.session.state).toBe('closed');
        expect(h.of('session.state')).toContainEqual({ from: 'open', to: 'closed', reason: 'fenced' });
    });

    it('announces who holds the session now', async () => {
        const h = await fenced();

        expect(h.of('session.fenced')).toEqual([{ owner: 'inst-2' }]);
    });

    it('drops the token, so nothing later tries to renew or release it', async () => {
        const h = await fenced();

        expect(h.session.lock).toBeUndefined();
    });

    it('does not reconnect, which would take the session back from its new owner', async () => {
        const h = await fenced();
        const opened = h.driver.sockets.length;

        await vi.advanceTimersByTimeAsync(TTL * 4);

        expect(h.driver.sockets).toHaveLength(opened);
    });

    it('refuses sends afterwards', async () => {
        const h = await fenced();

        await expect(h.session.send('628123456789', { text: 'hi' })).rejects.toMatchObject({
            code: 'SESSION_NOT_READY',
        });
    });
});

describe('releasing', () => {
    it('hands the lock back on stop', async () => {
        const h = harness();
        await h.session.start();

        await h.session.stop();

        expect(h.session.lock).toBeUndefined();
        await expect(h.lock.inspect(KEY)).resolves.toBeNull();
    });

    it('lets another instance start once the first has stopped', async () => {
        const shared = memoryLock();
        const first = harness(shared);
        await first.session.start();
        await first.session.stop();

        const second = harness(shared);
        await expect(second.session.start()).resolves.toBeUndefined();
    });

    it('hands the lock back on logout', async () => {
        const h = harness();
        await h.session.start();
        await h.driver.last.open();

        await h.session.logout();

        await expect(h.lock.inspect(KEY)).resolves.toBeNull();
    });

    it('hands the lock back on destroy', async () => {
        const h = harness();
        await h.session.start();

        await h.session.destroy();

        await expect(h.lock.inspect(KEY)).resolves.toBeNull();
    });

    it('stops the heartbeat, so a stopped session cannot renew a lock it gave up', async () => {
        const inner = memoryLock();
        const renew = vi.fn((token: LockToken, ttlMs: number) => inner.renew(token, ttlMs));
        const h = harness({ ...inner, renew });
        await h.session.start();

        await h.session.stop();
        await vi.advanceTimersByTimeAsync(TTL * 4);

        expect(renew).not.toHaveBeenCalled();
    });

    it('still stops when the release fails, because the lease lapses by itself', async () => {
        const lock = scriptedLock();
        const h = harness(lock);
        await h.session.start();
        lock.releaseError = new Error('backend unreachable');

        await expect(h.session.stop()).resolves.toBeUndefined();
        expect(h.session.state).toBe('closed');
    });
});
