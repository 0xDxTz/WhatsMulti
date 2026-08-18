/**
 * Runtime access to Baileys.
 *
 * `baileys.ts` is types only, so it disappears at compile time. This module is the
 * one place that actually *loads* the driver, and it does so lazily via a dynamic
 * import. That is a deliberate trade:
 *
 * - `import 'whatsmulti'` stays free of the Baileys module graph. Reading
 *   SPEC_VERSION, building a storage adapter or handling an error costs nothing.
 * - A missing peer surfaces as a typed MISSING_PEER naming the install command,
 *   instead of a raw ERR_MODULE_NOT_FOUND from deep inside our import chain.
 *
 * The loader is swappable, which is what makes running against a Baileys fork a
 * supported configuration rather than a patch-package job.
 */
import type * as Baileys from '@whiskeysockets/baileys';

import { WhatsMultiError } from '../errors.js';

/** The driver's module shape. Erased at compile time -- see the note above. */
export type BaileysModule = typeof Baileys;

export type DriverLoader = () => Promise<BaileysModule>;

const PEER = '@whiskeysockets/baileys';

// The specifier stays a literal: a variable would erase the module's types and
// leave bundlers unable to resolve it.
const defaultLoader: DriverLoader = () => import('@whiskeysockets/baileys');

let loader: DriverLoader = defaultLoader;
let pending: Promise<BaileysModule> | undefined;

/**
 * Point the library at a different driver build -- a fork, or a stub in tests.
 * Pass null to restore the default. Either way the memoised module is dropped, so
 * the next call reloads.
 */
export function setDriverLoader(next: DriverLoader | null): void {
    loader = next ?? defaultLoader;
    pending = undefined;
}

/**
 * The Baileys module, loaded once per process.
 *
 * A failed load is not memoised: installing the peer and retrying inside a
 * long-lived process then works, rather than failing forever against a cached
 * rejection.
 */
export async function loadDriver(): Promise<BaileysModule> {
    pending ??= loader().catch((cause: unknown) => {
        pending = undefined;
        throw new WhatsMultiError('MISSING_PEER', {
            params: { feature: 'WhatsMulti', peer: PEER, install: `npm install ${PEER}` },
            cause,
        });
    });
    return pending;
}
