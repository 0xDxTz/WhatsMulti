/**
 * Reconnect policy: which disconnects are worth retrying, and when.
 *
 * The schedule itself is `backoffDelay` in utils -- exponential with full jitter, the
 * same arithmetic the webhook forwarder retries on. What lives here is the policy:
 * a terminal cause is never retried, an immediate cause costs no attempt, and a
 * finite `maxAttempts` is exhaustible.
 *
 * v1 had none of this: one cause reconnected, immediately, forever.
 */
import type { ReconnectConfig } from '../config.js';
import type { DisconnectCause } from '../generated/index.js';
import { backoffDelay } from '../utils/backoff.js';
import { createRandom } from '../utils/random.js';

import { decisionFor } from './disconnect.js';

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
