import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LockProvider } from '../../src/lock.js';

/**
 * One suite, run against every lock provider.
 *
 * Fencing is the one failure mode in this package where being wrong corrupts data
 * rather than dropping a message: two processes on one session write the same Signal
 * key store. So the contract is asserted here once, and every backend -- including a
 * third-party one -- is finished when this is green.
 *
 * Expiry is waited out rather than simulated, because a real backend's clock is its
 * own. The TTLs are therefore short enough to be quick and long enough that a slow
 * machine does not fail the suite spuriously.
 */
export interface LockConformanceHarness {
    readonly create: () => LockProvider | Promise<LockProvider>;
    readonly teardown?: (provider: LockProvider) => void | Promise<void>;
}

const TTL = 30_000;
/** Long enough to survive a slow round trip, short enough to wait out. */
const BRIEF = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function runLockConformance(name: string, harness: LockConformanceHarness): void {
    describe(`lock conformance: ${name}`, () => {
        let lock: LockProvider;
        let counter = 0;

        /** A fresh key per case, so nothing has to be torn down between them. */
        const key = (): string => `session:conf-${name}-${++counter}`;

        beforeAll(async () => {
            lock = await harness.create();
        });

        afterAll(async () => {
            await harness.teardown?.(lock);
            await lock.close?.();
        });

        it('exposes a non-empty name', () => {
            expect(typeof lock.name).toBe('string');
            expect(lock.name.length).toBeGreaterThan(0);
        });

        describe('acquire', () => {
            it('grants the lock and records the key, owner and expiry', async () => {
                const k = key();
                const before = Date.now();

                const held = await lock.acquire(k, TTL, 'inst-1');

                expect(held).toMatchObject({ key: k, owner: 'inst-1' });
                expect(held?.token).toBeTruthy();
                expect(held?.expiresAt).toBeGreaterThanOrEqual(before);
            });

            it('refuses a second caller while the first holds it', async () => {
                const k = key();
                await lock.acquire(k, TTL, 'inst-1');

                await expect(lock.acquire(k, TTL, 'inst-2')).resolves.toBeNull();
            });

            it('does not let one key block another', async () => {
                await lock.acquire(key(), TTL, 'inst-1');

                await expect(lock.acquire(key(), TTL, 'inst-2')).resolves.not.toBeNull();
            });

            it('hands an expired lock over, because a dead holder cannot release it', async () => {
                const k = key();
                await lock.acquire(k, BRIEF, 'inst-1');

                await sleep(BRIEF * 2);

                await expect(lock.acquire(k, TTL, 'inst-2')).resolves.toMatchObject({ owner: 'inst-2' });
            });

            it('mints a distinct token per acquisition', async () => {
                const k = key();
                const first = await lock.acquire(k, BRIEF, 'inst-1');
                await sleep(BRIEF * 2);
                const second = await lock.acquire(k, TTL, 'inst-1');

                expect(second?.token).not.toBe(first?.token);
            });
        });

        describe('renew', () => {
            it('extends the lease and keeps the same acquisition', async () => {
                const k = key();
                const held = (await lock.acquire(k, BRIEF, 'inst-1'))!;

                const renewed = await lock.renew(held, TTL);

                expect(renewed).toMatchObject({ key: k, token: held.token, owner: 'inst-1' });
                expect(renewed!.expiresAt).toBeGreaterThan(held.expiresAt);
            });

            it('keeps the lock unavailable past the original lease', async () => {
                const k = key();
                const held = (await lock.acquire(k, BRIEF, 'inst-1'))!;

                await lock.renew(held, TTL);
                await sleep(BRIEF * 2);

                await expect(lock.acquire(k, TTL, 'inst-2')).resolves.toBeNull();
            });

            it('refuses once another instance has taken it', async () => {
                const k = key();
                const held = (await lock.acquire(k, BRIEF, 'inst-1'))!;
                await sleep(BRIEF * 2);
                await lock.acquire(k, TTL, 'inst-2');

                await expect(lock.renew(held, TTL)).resolves.toBeNull();
            });

            it('refuses a lapsed lease even when nobody else has claimed it', async () => {
                // A process that stopped proving it was alive has lost the lock,
                // whether or not anyone noticed.
                const k = key();
                const held = (await lock.acquire(k, BRIEF, 'inst-1'))!;

                await sleep(BRIEF * 2);

                await expect(lock.renew(held, TTL)).resolves.toBeNull();
            });

            it('refuses a token for a lock that was never taken', async () => {
                const stale = { key: key(), token: 'not-a-token', owner: 'inst-1', expiresAt: Date.now() + TTL };

                await expect(lock.renew(stale, TTL)).resolves.toBeNull();
            });
        });

        describe('release', () => {
            it('frees the lock for the next caller', async () => {
                const k = key();
                const held = (await lock.acquire(k, TTL, 'inst-1'))!;

                await lock.release(held);

                await expect(lock.acquire(k, TTL, 'inst-2')).resolves.toMatchObject({ owner: 'inst-2' });
            });

            it('ignores a token that is no longer the holder', async () => {
                // Why release matches on token and never on owner: an instance id
                // outlives one acquisition, so an owner match would let a stale holder
                // free the lock a newer incarnation of itself has since taken.
                const k = key();
                const first = (await lock.acquire(k, BRIEF, 'inst-1'))!;
                await sleep(BRIEF * 2);
                const second = (await lock.acquire(k, TTL, 'inst-1'))!;

                await lock.release(first);

                await expect(lock.inspect(k)).resolves.toMatchObject({ token: second.token });
            });

            it('is safe to call twice', async () => {
                const held = (await lock.acquire(key(), TTL, 'inst-1'))!;

                await lock.release(held);
                await expect(lock.release(held)).resolves.toBeUndefined();
            });
        });

        describe('inspect', () => {
            it('names the holder', async () => {
                const k = key();
                await lock.acquire(k, TTL, 'inst-1');

                await expect(lock.inspect(k)).resolves.toMatchObject({ owner: 'inst-1' });
            });

            it('reports an unheld key as free', async () => {
                await expect(lock.inspect(key())).resolves.toBeNull();
            });

            it('reports an expired lock as free', async () => {
                const k = key();
                await lock.acquire(k, BRIEF, 'inst-1');

                await sleep(BRIEF * 2);

                await expect(lock.inspect(k)).resolves.toBeNull();
            });
        });

        describe('contention', () => {
            it('grants exactly one of a burst of simultaneous callers', async () => {
                const k = key();

                const results = await Promise.all(
                    Array.from({ length: 8 }, (_, i) => lock.acquire(k, TTL, `inst-${i}`))
                );

                expect(results.filter((held) => held !== null)).toHaveLength(1);
            });
        });
    });
}
