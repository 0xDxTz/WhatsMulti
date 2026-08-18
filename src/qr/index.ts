/**
 * QR rendering, behind the optional `qrcode` peer.
 *
 * Its own entry point -- `@dutakey/whatsmulti/qr` -- rather than part of the barrel,
 * for two reasons. Core has zero runtime dependencies and this is the one place that
 * would need one; and most consumers never want a rendered QR at all, because a web
 * client wants the raw string to draw itself, not a PNG whose palette we picked.
 *
 * It exists because Baileys 7 removed `printQRInTerminal`, so the terminal rendering
 * every getting-started script needs has to live somewhere.
 *
 * The peer is loaded dynamically and only when one of these functions is called:
 * importing this module costs nothing, and a consumer who never renders never has to
 * install anything.
 */
import { WhatsMultiError } from '../errors.js';

const PEER = 'qrcode';
const INSTALL = `npm install ${PEER}`;

export type QrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrOptions {
    /** Higher levels survive more damage at the cost of density. `qrcode` defaults to M. */
    readonly errorCorrectionLevel?: QrErrorCorrectionLevel | undefined;
    /** Quiet-zone width in modules. Scanners need one; do not set it to 0. */
    readonly margin?: number | undefined;
    readonly scale?: number | undefined;
    /** Takes precedence over `scale`. Ignored when smaller than the symbol. */
    readonly width?: number | undefined;
    readonly color?: { readonly dark?: string | undefined; readonly light?: string | undefined } | undefined;
}

export interface QrTerminalOptions extends QrOptions {
    /**
     * Half-height block glyphs: half the rows, still scannable, and the only form
     * that fits an 80x24 terminal. Defaults to true, which is the opposite of the
     * renderer's own default.
     */
    readonly small?: boolean | undefined;
}

export interface QrPrintOptions extends QrTerminalOptions {
    /** Where the rendered code goes. Defaults to stdout. Injected in tests. */
    readonly write?: ((chunk: string) => void) | undefined;
}

/**
 * The slice of `qrcode` we use, declared structurally.
 *
 * Declared here rather than imported so that `dist/qr/index.d.ts` never references
 * the peer: a consumer who has not installed it -- which is every consumer who does
 * not render QR codes -- would otherwise fail to typecheck.
 */
type RendererOptions = QrOptions & { readonly type?: string | undefined; readonly small?: boolean | undefined };

interface QrRenderer {
    toString(text: string, options: RendererOptions): Promise<string>;
    toDataURL(text: string, options: RendererOptions): Promise<string>;
    toBuffer(text: string, options: RendererOptions): Promise<Buffer>;
}

export type QrLoader = () => Promise<unknown>;

// The specifier stays a literal: a variable would leave bundlers unable to resolve
// it. Same reasoning as src/compat/driver.ts.
const defaultLoader: QrLoader = () => import('qrcode');

let loader: QrLoader = defaultLoader;
let pending: Promise<QrRenderer> | undefined;

/** Swaps the renderer -- for a fork, or for a test. `null` restores the default. */
export function setQrLoader(next: QrLoader | null): void {
    loader = next ?? defaultLoader;
    pending = undefined;
}

function missingPeer(cause?: unknown): WhatsMultiError {
    return new WhatsMultiError('MISSING_PEER', {
        params: { feature: 'QR rendering', peer: PEER, install: INSTALL },
        ...(cause === undefined ? {} : { cause }),
    });
}

/**
 * `qrcode` is CommonJS, so an ESM import may hand back the module either as the
 * namespace or under `default`, depending on how it was resolved. A module that has
 * neither is reported as missing rather than left to fail with a TypeError deep in a
 * call: the fix is the same either way, which is to install a usable copy.
 */
function asRenderer(module: unknown): QrRenderer {
    const candidates = [module, (module as { default?: unknown } | null)?.default];

    for (const candidate of candidates) {
        if (typeof candidate !== 'object' && typeof candidate !== 'function') continue;
        if (candidate === null) continue;
        // Probed on toDataURL and toBuffer, never on toString: every object inherits
        // one from Object.prototype, so it would accept anything.
        const api = candidate as Partial<QrRenderer>;
        if (typeof api.toDataURL === 'function' && typeof api.toBuffer === 'function') {
            return candidate as QrRenderer;
        }
    }

    throw missingPeer();
}

/** The renderer, loaded once. Throws MISSING_PEER naming the install command. */
export async function loadQrRenderer(): Promise<QrRenderer> {
    pending ??= loader()
        .catch((cause: unknown) => {
            pending = undefined;
            throw missingPeer(cause);
        })
        .then(asRenderer);
    return pending;
}

/** The QR as terminal-safe text, ready to write somewhere. */
export async function toTerminal(qr: string, options: QrTerminalOptions = {}): Promise<string> {
    const renderer = await loadQrRenderer();
    return renderer.toString(qr, { small: true, ...options, type: 'terminal' });
}

/** The QR as an SVG document. */
export async function toSvg(qr: string, options: QrOptions = {}): Promise<string> {
    const renderer = await loadQrRenderer();
    return renderer.toString(qr, { ...options, type: 'svg' });
}

/** The QR as a `data:image/png;base64,...` URL, for an `<img src>`. */
export async function toDataURL(qr: string, options: QrOptions = {}): Promise<string> {
    const renderer = await loadQrRenderer();
    return renderer.toDataURL(qr, { ...options, type: 'image/png' });
}

/** The QR as raw PNG bytes, for a file or an HTTP response. */
export async function toBuffer(qr: string, options: QrOptions = {}): Promise<Buffer> {
    const renderer = await loadQrRenderer();
    return renderer.toBuffer(qr, { ...options, type: 'png' });
}

/**
 * Writes the QR where a person can scan it. This is what `qr.print` drives.
 *
 * stdout, not the logger: a structured logger either escapes the block glyphs or
 * wraps them in JSON, and both make the code unscannable.
 */
export async function printQr(qr: string, options: QrPrintOptions = {}): Promise<void> {
    const { write, ...rest } = options;
    const sink = write ?? ((chunk: string) => void process.stdout.write(chunk));
    sink(`\n${await toTerminal(qr, rest)}\n`);
}
