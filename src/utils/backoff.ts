/**
 * Exponential backoff with full jitter and a floor, normative in spec/algorithms.md
 * section 2 and pinned by spec/vectors/backoff.json.
 *
 * Full jitter -- a delay drawn uniformly from the whole window rather than the top of
 * it -- is what stops a fleet of callers that failed together from retrying together.
 * The floor keeps the first retries from hammering a server that is merely slow.
 *
 * This is arithmetic, not policy: the reconnect policy and the webhook forwarder both
 * retry on this schedule, each with its own config block. It lives here rather than in
 * the session layer so that the second caller does not have to reach into the first.
 */

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
