/**
 * Reconnect policy: exponential backoff with full jitter and a floor, normative in
 * spec/algorithms.md section 2 and pinned by spec/vectors/backoff.json.
 *
 * Full jitter -- a delay drawn uniformly from the whole window rather than the top of
 * it -- is what stops a fleet of sessions that dropped together from reconnecting
 * together. The floor keeps the first retries from hammering a server that is merely
 * slow.
 *
 * v1 had none of this: one cause reconnected, immediately, forever.
 */
import type { ReconnectConfig } from '../config.js';
import type { DisconnectCause } from '../generated/index.js';
import { createRandom } from '../utils/random.js';

import { decisionFor } from './disconnect.js';

export interface BackoffConfig {
    readonly baseMs: number;
    readonly capMs: number;
    readonly floorMs: number;
}

/**
 * The delay for a 1-based attempt.
 *
 * `base << shift` in the spec is written as a multiplication here: a 1-second base at
 * attempt 32 would overflow a 32-bit shift and wrap to a negative delay, while `2 **
 * shift` saturates against `capMs` as intended. The shift is clamped at 30 for the
 * same reason, and at 0 so a non-positive attempt cannot produce a fractional base.
 */
export function backoffDelay(attempt: number, config: BackoffConfig, rand: () => number): number {
    const shift = Math.max(0, Math.min(attempt - 1, 30));
    const expMs = Math.min(config.capMs, config.baseMs * 2 ** shift);
    if (expMs <= config.floorMs) return config.floorMs;
    return config.floorMs + Math.floor(rand() * (expMs - config.floorMs));
}

export type ReconnectRefusal = 'terminal' | 'disabled' | 'exhausted';

export type ReconnectPlan =
    | {
          readonly retry: true;
          readonly cause: DisconnectCause;
          /** Attempts consumed so far. 0 for an immediate reconnect, which consumes none. */
          readonly attempt: number;
          readonly delayMs: number;
      }
    | {
          readonly retry: false;
          readonly cause: DisconnectCause;
          readonly reason: ReconnectRefusal;
      };

export interface ReconnectPolicyOptions {
    readonly config: ReconnectConfig;
    /** Seeded once per session. Pass a fixture generator to make delays reproducible. */
    readonly random?: (() => number) | undefined;
}

export class ReconnectPolicy {
    readonly #config: ReconnectConfig;
    readonly #random: () => number;
    #attempt = 0;

    constructor(options: ReconnectPolicyOptions) {
        this.#config = options.config;
        this.#random = options.random ?? createRandom();
    }

    /** Attempts consumed since the last successful open. */
    get attempt(): number {
        return this.#attempt;
    }

    /** Call on every transition into `open`. */
    reset(): void {
        this.#attempt = 0;
    }

    /**
     * Decides whether and when to reconnect, consuming an attempt if it does.
     *
     * `terminal` is checked before `enabled` on purpose: refusing to reconnect after a
     * logout is a property of the cause, not a configuration choice, and reporting it
     * as `disabled` would hide why the session actually stopped.
     */
    plan(cause: DisconnectCause): ReconnectPlan {
        const { action } = decisionFor(cause);

        if (action === 'terminal') return { retry: false, cause, reason: 'terminal' };
        if (!this.#config.enabled) return { retry: false, cause, reason: 'disabled' };

        // The expected post-pairing stream restart. It is not a failure, so it neither
        // consumes an attempt nor waits.
        if (action === 'reconnect_immediate') {
            return { retry: true, cause, attempt: this.#attempt, delayMs: 0 };
        }

        const attempt = this.#attempt + 1;
        if (this.#config.maxAttempts > 0 && attempt > this.#config.maxAttempts) {
            // Left un-consumed, so the counter reads as the cap rather than one past it.
            return { retry: false, cause, reason: 'exhausted' };
        }

        this.#attempt = attempt;
        return { retry: true, cause, attempt, delayMs: backoffDelay(attempt, this.#config, this.#random) };
    }
}
