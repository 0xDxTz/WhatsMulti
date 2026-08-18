import { describe, expect, it } from 'vitest';

import { memoryLock, sessionLockKey, type LockProvider } from '../../src/lock.js';

const TTL = 30_000;

/** A provider driven by a clock the test owns, so expiry never needs waiting for. */
function clocked(): { lock: LockProvider; advance: (ms: number) => void } {
    let time = 1_000;
    let minted = 0;

    return {
        lock: memoryLock({ now: () => time, mintToken: () => `t${++minted}` }),
        advance: (ms) => {
            time += ms;
        },
    };
}

describe('sessionLockKey', () => {
    it('matches the shared schema', () => {
        expect(sessionLockKey('a')).toBe('session:a');
    });
});

describe('acquire', () => {
    it('grants the lock to the first caller and records who holds it', async () => {
        const { lock } = clocked();

        const held = await lock.acquire('session:a', TTL, 'inst-1');

        expect(held).toMatchObject({ key: 'session:a', owner: 'inst-1', expiresAt: 1_000 + TTL });
        expect(held?.token).toBeTruthy();
    });

    it('refuses a second caller while the first still holds it', async () => {
        const { lock } = clocked();
        await lock.acquire('session:a', TTL, 'inst-1');

        await expect(lock.acquire('session:a', TTL, 'inst-2')).resolves.toBeNull();
    });

    it('does not let one session block another', async () => {
        const { lock } = clocked();
        await lock.acquire('session:a', TTL, 'inst-1');

        await expect(lock.acquire('session:b', TTL, 'inst-2')).resolves.not.toBeNull();
    });

    it('hands an expired lock to the next caller, because a dead holder cannot release', async () => {
        const { lock, advance } = clocked();
        await lock.acquire('session:a', TTL, 'inst-1');

        advance(TTL + 1);

        await expect(lock.acquire('session:a', TTL, 'inst-2')).resolves.toMatchObject({ owner: 'inst-2' });
    });

    it('still refuses on the tick the lease is due, not a millisecond early', async () => {
        const { lock, advance } = clocked();
        await lock.acquire('session:a', TTL, 'inst-1');

        advance(TTL);

        await expect(lock.acquire('session:a', TTL, 'inst-2')).resolves.toBeNull();
    });

    it('mints a fresh token per acquisition', async () => {
        const { lock, advance } = clocked();
        const first = await lock.acquire('session:a', TTL, 'inst-1');
        advance(TTL + 1);
        const second = await lock.acquire('session:a', TTL, 'inst-2');

        expect(second?.token).not.toBe(first?.token);
    });
});

describe('renew', () => {
    it('extends the lease from now, not from the old expiry', async () => {
        const { lock, advance } = clocked();
        const held = await lock.acquire('session:a', TTL, 'inst-1');
        advance(10_000);

        const renewed = await lock.renew(held!, TTL);

        expect(renewed).toMatchObject({ token: held!.token, expiresAt: 11_000 + TTL });
    });

    it('keeps the lock unavailable to anyone else', async () => {
        const { lock, advance } = clocked();
        const held = await lock.acquire('session:a', TTL, 'inst-1');

        advance(20_000);
        await lock.renew(held!, TTL);
        advance(20_000);

        await expect(lock.acquire('session:a', TTL, 'inst-2')).resolves.toBeNull();
    });

    it('refuses once someone else holds it', async () => {
        const { lock, advance } = clocked();
        const held = await lock.acquire('session:a', TTL, 'inst-1');

        advance(TTL + 1);
        await lock.acquire('session:a', TTL, 'inst-2');

        await expect(lock.renew(held!, TTL)).resolves.toBeNull();
    });

    it('refuses a lapsed lease even when nobody has taken it', async () => {
        // A process that stopped proving it was alive has lost the lock, whether or
        // not anyone noticed. Anything else lets a stalled instance resume as though
        // the gap never happened.
        const { lock, advance } = clocked();
        const held = await lock.acquire('session:a', TTL, 'inst-1');

        advance(TTL + 1);

        await expect(lock.renew(held!, TTL)).resolves.toBeNull();
    });

    it('refuses a token for a lock that was never taken', async () => {
        const { lock } = clocked();

        const stale = { key: 'session:ghost', token: 'nope', owner: 'inst-1', expiresAt: 0 };
        await expect(lock.renew(stale, TTL)).resolves.toBeNull();
    });
});

describe('release', () => {
    it('frees the lock for the next caller', async () => {
        const { lock } = clocked();
        const held = await lock.acquire('session:a', TTL, 'inst-1');

        await lock.release(held!);

        await expect(lock.acquire('session:a', TTL, 'inst-2')).resolves.toMatchObject({ owner: 'inst-2' });
    });

    it('ignores a token that is no longer the holder', async () => {
        // The reason renew and release match on token and never on owner: an instance
        // id outlives one acquisition, so an owner match would let a stale holder
        // release the lock a newer incarnation of itself has since taken.
        const { lock, advance } = clocked();
        const first = await lock.acquire('session:a', TTL, 'inst-1');
        advance(TTL + 1);
        const second = await lock.acquire('session:a', TTL, 'inst-1');

        await lock.release(first!);

        await expect(lock.inspect('session:a')).resolves.toMatchObject({ token: second!.token });
    });

    it('is safe to call twice', async () => {
        const { lock } = clocked();
        const held = await lock.acquire('session:a', TTL, 'inst-1');

        await lock.release(held!);
        await expect(lock.release(held!)).resolves.toBeUndefined();
    });
});

describe('inspect', () => {
    it('names the holder', async () => {
        const { lock } = clocked();
        await lock.acquire('session:a', TTL, 'inst-1');

        await expect(lock.inspect('session:a')).resolves.toMatchObject({ owner: 'inst-1' });
    });

    it('reports an unheld lock as free', async () => {
        const { lock } = clocked();

        await expect(lock.inspect('session:a')).resolves.toBeNull();
    });

    it('reports an expired lock as free', async () => {
        const { lock, advance } = clocked();
        await lock.acquire('session:a', TTL, 'inst-1');

        advance(TTL + 1);

        await expect(lock.inspect('session:a')).resolves.toBeNull();
    });
});

describe('isolation', () => {
    it('gives each provider its own store, so two clients cannot fight by accident', async () => {
        const a = memoryLock();
        const b = memoryLock();

        await a.acquire('session:a', TTL, 'inst-1');

        await expect(b.acquire('session:a', TTL, 'inst-2')).resolves.not.toBeNull();
    });

    it('fences for real when the provider is shared', async () => {
        const shared = memoryLock();

        await expect(shared.acquire('session:a', TTL, 'inst-1')).resolves.not.toBeNull();
        await expect(shared.acquire('session:a', TTL, 'inst-2')).resolves.toBeNull();
    });
});
