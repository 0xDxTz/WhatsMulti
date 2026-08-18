/**
 * Runtime access to Hono.
 *
 * Same shape as the Baileys loader: types are imported type-only and erased, the
 * module itself arrives through a dynamic import, and a missing peer surfaces as a
 * typed MISSING_PEER naming the install command rather than a raw
 * ERR_MODULE_NOT_FOUND from inside our import chain.
 *
 * Unlike the driver, Hono is genuinely required for this entry point -- there is no
 * control plane without an HTTP framework -- so the loader exists for the error
 * message and for tests, not to keep the peer optional at runtime.
 */
import type { Hono } from 'hono';
import type { streamSSE } from 'hono/streaming';

import { WhatsMultiError } from '../errors.js';

export interface HonoRuntime {
    readonly Hono: typeof Hono;
    readonly streamSSE: typeof streamSSE;
}

export type HonoLoader = () => Promise<HonoRuntime>;

const PEER = 'hono';

// The specifiers stay literals: a variable would erase the modules' types and leave
// bundlers unable to resolve them.
const defaultLoader: HonoLoader = async () => {
    const [hono, streaming] = await Promise.all([import('hono'), import('hono/streaming')]);
    return { Hono: hono.Hono, streamSSE: streaming.streamSSE };
};

let loader: HonoLoader = defaultLoader;
let pending: Promise<HonoRuntime> | undefined;

/** Swap the module in, for a fork or a test double. Pass null to restore. */
export function setHonoLoader(next: HonoLoader | null): void {
    loader = next ?? defaultLoader;
    pending = undefined;
}

/**
 * The Hono module, loaded once per process. A failed load is not memoised, so
 * installing the peer and retrying inside a long-lived process works.
 */
export async function loadHono(): Promise<HonoRuntime> {
    pending ??= loader().catch((cause: unknown) => {
        pending = undefined;
        throw new WhatsMultiError('MISSING_PEER', {
            params: { feature: 'The control plane', peer: PEER, install: `npm install ${PEER}` },
            cause,
        });
    });
    return pending;
}
