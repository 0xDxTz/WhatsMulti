/**
 * The deterministic PRNG from spec/algorithms.md section 1: mulberry32.
 *
 * Reconnect delays carry full jitter, which would make them untestable across
 * languages if each runtime used its own random source. Fixing the algorithm means a
 * seeded sequence is identical in TypeScript and Go, and spec/vectors/backoff.json
 * can pin it for both.
 *
 * All arithmetic is on unsigned 32-bit integers with wraparound. The `>>> 0` after
 * every step is not decoration: JavaScript bitwise operators yield signed 32-bit
 * values, and a single missing coercion produces a different stream from the Go
 * implementation.
 */
import { randomBytes } from 'node:crypto';

export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
        t = (t ^ (t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0))) >>> 0;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A cryptographically drawn seed. Production seeds this way; tests pass a fixture. */
export function randomSeed(): number {
    return randomBytes(4).readUInt32BE(0);
}

/**
 * A generator seeded once, per session. Omit the seed in production; pass one to
 * reproduce a sequence.
 */
export function createRandom(seed?: number): () => number {
    return mulberry32(seed ?? randomSeed());
}
