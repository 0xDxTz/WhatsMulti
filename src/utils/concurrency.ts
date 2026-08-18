/**
 * Bounded fan-out.
 *
 * v1 loaded every stored session with an unbounded `Promise.all`, so restoring a
 * hundred sessions opened a hundred sockets at once and hit both the storage backend
 * and WhatsApp with a burst that looks exactly like abuse.
 */

/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving input order
 * in the result.
 *
 * Rejects on the first failure, like `Promise.all` -- workers already in flight run
 * to completion, but no new ones start. Callers that must not abort early wrap their
 * own worker in a try/catch; `destroy()` does exactly that.
 */
export async function mapLimit<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    const width = Math.max(1, Math.min(limit, items.length));
    let cursor = 0;

    const run = async (): Promise<void> => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index] as T, index);
        }
    };

    await Promise.all(Array.from({ length: width }, run));
    return results;
}
