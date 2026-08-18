import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, type ReconnectConfig } from '../../src/config.js';
import { DISCONNECT_ACTIONS, DISCONNECT_CAUSES } from '../../src/generated/index.js';
import { ReconnectPolicy } from '../../src/session/reconnect.js';
import { backoffDelay } from '../../src/utils/backoff.js';
import { mulberry32, createRandom, randomSeed } from '../../src/utils/random.js';

const vectors = JSON.parse(readFileSync('spec/vectors/backoff.json', 'utf8')) as {
    configs: { name: string; base_ms: number; cap_ms: number; floor_ms: number }[];
    cases: { config: string; seed: number; delays: number[] }[];
    prngProbe: { values: Record<string, number[]> };
};

const configFor = (name: string) => {
    const found = vectors.configs.find((entry) => entry.name === name);
    if (!found) throw new Error(`no config ${name}`);
    return { baseMs: found.base_ms, capMs: found.cap_ms, floorMs: found.floor_ms };
};

const reconnect = (overrides: Partial<ReconnectConfig> = {}): ReconnectConfig => ({
    ...DEFAULT_CONFIG.reconnect,
    ...overrides,
});

describe('mulberry32 against spec/vectors/backoff.json', () => {
    it.each(Object.entries(vectors.prngProbe.values))('reproduces the raw stream for seed %s', (seed, expected) => {
        const rand = mulberry32(Number(seed));

        expect(Array.from({ length: expected.length }, () => rand())).toEqual(expected);
    });

    it('is a pure function of the seed', () => {
        expect(Array.from({ length: 5 }, mulberry32(7))).toEqual(Array.from({ length: 5 }, mulberry32(7)));
    });

    it('stays inside [0, 1)', () => {
        const rand = mulberry32(0);

        for (let i = 0; i < 1000; i++) {
            const value = rand();
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
    });

    it('accepts a seed beyond 32 bits by wrapping it', () => {
        expect(mulberry32(2 ** 32 + 7)()).toBe(mulberry32(7)());
    });
});

describe('randomSeed', () => {
    it('produces a 32-bit unsigned integer', () => {
        const seed = randomSeed();

        expect(Number.isInteger(seed)).toBe(true);
        expect(seed).toBeGreaterThanOrEqual(0);
        expect(seed).toBeLessThan(2 ** 32);
    });

    it('does not repeat itself in practice', () => {
        expect(new Set(Array.from({ length: 50 }, randomSeed)).size).toBeGreaterThan(40);
    });
});

describe('createRandom', () => {
    it('reproduces a sequence when seeded', () => {
        expect(createRandom(99)()).toBe(mulberry32(99)());
    });

    it('draws its own seed when not', () => {
        expect(createRandom()()).not.toBe(createRandom()());
    });
});

describe('backoffDelay against spec/vectors/backoff.json', () => {
    it.each(vectors.cases)('$config, seed $seed', (vector) => {
        const config = configFor(vector.config);
        const rand = mulberry32(vector.seed);

        const delays = vector.delays.map((_, index) => backoffDelay(index + 1, config, rand));

        expect(delays).toEqual(vector.delays);
    });

    it('never returns less than the floor', () => {
        const config = configFor('default');
        const rand = mulberry32(1);

        for (let attempt = 1; attempt <= 20; attempt++) {
            expect(backoffDelay(attempt, config, rand)).toBeGreaterThanOrEqual(config.floorMs);
        }
    });

    it('never exceeds the cap', () => {
        const config = configFor('default');
        const rand = () => 0.999999;

        for (let attempt = 1; attempt <= 40; attempt++) {
            expect(backoffDelay(attempt, config, rand)).toBeLessThan(config.capMs);
        }
    });

    it('returns the floor exactly when the floor dominates the window', () => {
        // base 100, cap 400, floor 500: the exponential term can never exceed the
        // floor, so the delay is constant and seed-independent by design.
        const config = configFor('floor_dominates');

        expect(backoffDelay(1, config, () => 0.5)).toBe(config.floorMs);
        expect(backoffDelay(12, config, () => 0.5)).toBe(config.floorMs);
    });

    it('draws from the whole window, not just the top of it', () => {
        // Full jitter is what stops a fleet that dropped together from reconnecting
        // together.
        const config = configFor('default');

        expect(backoffDelay(6, config, () => 0)).toBe(config.floorMs);
        expect(backoffDelay(6, config, () => 0.999999)).toBeGreaterThan(30_000);
    });

    it('saturates instead of overflowing at a huge attempt number', () => {
        // A 32-bit shift would wrap and produce a negative delay.
        const config = configFor('default');

        expect(backoffDelay(1000, config, () => 0.5)).toBeGreaterThan(config.floorMs);
        expect(backoffDelay(1000, config, () => 0.5)).toBeLessThan(config.capMs);
    });

    it('clamps a non-positive attempt to the first one', () => {
        const config = configFor('default');

        expect(backoffDelay(0, config, () => 0.5)).toBe(backoffDelay(1, config, () => 0.5));
    });
});

describe('ReconnectPolicy', () => {
    const policy = (config: Partial<ReconnectConfig> = {}, seed = 1) =>
        new ReconnectPolicy({ config: reconnect(config), random: mulberry32(seed) });

    it('starts with no attempts consumed', () => {
        expect(policy().attempt).toBe(0);
    });

    it('refuses every terminal cause, whatever the config says', () => {
        for (const cause of DISCONNECT_CAUSES.filter((c) => DISCONNECT_ACTIONS[c] === 'terminal')) {
            expect(policy().plan(cause)).toEqual({ retry: false, cause, reason: 'terminal' });
        }
    });

    it('reports terminal rather than disabled when both apply', () => {
        // Refusing to reconnect after a logout is a property of the cause, not a
        // configuration choice; reporting `disabled` would hide why it stopped.
        expect(policy({ enabled: false }).plan('logged_out')).toMatchObject({ reason: 'terminal' });
    });

    it('refuses when reconnect is switched off', () => {
        expect(policy({ enabled: false }).plan('connection_closed')).toEqual({
            retry: false,
            cause: 'connection_closed',
            reason: 'disabled',
        });
    });

    it('reconnects immediately after a stream restart, consuming nothing', () => {
        const p = policy();

        expect(p.plan('restart_required')).toEqual({
            retry: true,
            cause: 'restart_required',
            attempt: 0,
            delayMs: 0,
        });
        expect(p.attempt).toBe(0);
    });

    it('keeps an immediate reconnect free even after failures', () => {
        const p = policy();
        p.plan('connection_closed');
        p.plan('connection_closed');

        expect(p.plan('restart_required')).toMatchObject({ attempt: 2, delayMs: 0 });
        expect(p.attempt).toBe(2);
    });

    it('consumes one attempt per backed-off reconnect', () => {
        const p = policy();

        expect(p.plan('timed_out')).toMatchObject({ retry: true, attempt: 1 });
        expect(p.plan('timed_out')).toMatchObject({ retry: true, attempt: 2 });
        expect(p.attempt).toBe(2);
    });

    it('produces the spec delay sequence', () => {
        const config = configFor('default');
        const p = new ReconnectPolicy({
            config: reconnect({ baseMs: config.baseMs, capMs: config.capMs, floorMs: config.floorMs }),
            random: mulberry32(1),
        });
        const expected = vectors.cases.find((entry) => entry.config === 'default' && entry.seed === 1);

        const delays = expected?.delays.map(() => {
            const plan = p.plan('connection_closed');
            return plan.retry ? plan.delayMs : -1;
        });

        expect(delays).toEqual(expected?.delays);
    });

    it('gives up once the attempt cap is passed', () => {
        const p = policy({ maxAttempts: 2 });

        expect(p.plan('timed_out')).toMatchObject({ retry: true, attempt: 1 });
        expect(p.plan('timed_out')).toMatchObject({ retry: true, attempt: 2 });
        expect(p.plan('timed_out')).toEqual({ retry: false, cause: 'timed_out', reason: 'exhausted' });
    });

    it('leaves the counter at the cap rather than one past it', () => {
        const p = policy({ maxAttempts: 1 });
        p.plan('timed_out');
        p.plan('timed_out');

        expect(p.attempt).toBe(1);
    });

    it('stays exhausted until reset', () => {
        const p = policy({ maxAttempts: 1 });
        p.plan('timed_out');

        expect(p.plan('timed_out')).toMatchObject({ reason: 'exhausted' });
        expect(p.plan('timed_out')).toMatchObject({ reason: 'exhausted' });
    });

    it('treats maxAttempts 0 as unlimited', () => {
        const p = policy({ maxAttempts: 0 });

        for (let i = 0; i < 100; i++) expect(p.plan('timed_out').retry).toBe(true);
        expect(p.attempt).toBe(100);
    });

    it('resets the counter on a successful open', () => {
        const p = policy({ maxAttempts: 2 });
        p.plan('timed_out');
        p.plan('timed_out');

        p.reset();

        expect(p.attempt).toBe(0);
        expect(p.plan('timed_out')).toMatchObject({ retry: true, attempt: 1 });
    });

    it('reconnects on an unrecognised cause, but still under the cap', () => {
        const p = policy({ maxAttempts: 1 });

        expect(p.plan('unknown')).toMatchObject({ retry: true });
        expect(p.plan('unknown')).toMatchObject({ reason: 'exhausted' });
    });

    it('seeds itself when no generator is supplied', () => {
        const p = new ReconnectPolicy({ config: reconnect() });

        expect(p.plan('timed_out')).toMatchObject({ retry: true, attempt: 1 });
    });
});
