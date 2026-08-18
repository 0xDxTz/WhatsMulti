/**
 * Request signing, normative in spec/webhook.md and pinned by
 * spec/vectors/webhook-signature.json.
 *
 *     signedPayload = <t> + "." + <raw body bytes>
 *     v1            = lowercase_hex( HMAC_SHA256(secret, signedPayload) )
 *     header        = "t=" + <t> + ",v1=" + v1
 *
 * The timestamp is inside the MAC, not beside it: signing the body alone would let
 * anyone who captured one request replay it forever, and a receiver would have no way
 * to tell. It is unix *seconds*, and it is reused unchanged across retries of the same
 * delivery so that a receiver's replay window applies to the original send rather than
 * to whichever retry happened to arrive.
 *
 * The verifier ships too. Every consumer of this package has to write one, and a
 * hand-rolled `===` on a hex string is a timing oracle -- the exact mistake this
 * module exists to make unnecessary.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-whatsmulti-signature';
export const DELIVERY_HEADER = 'x-whatsmulti-delivery';
export const INSTANCE_HEADER = 'x-whatsmulti-instance';

/** spec/webhook.md recommends 300 seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface Signature {
    /** Unix seconds. */
    readonly t: number;
    /** Lowercase hex, 64 characters. */
    readonly v1: string;
    /** The ready-made header value. */
    readonly header: string;
}

/** The exact bytes the MAC covers. */
export function signedPayload(t: number, body: string): string {
    return `${t}.${body}`;
}

export function signPayload(secret: string, body: string, t: number): Signature {
    const v1 = createHmac('sha256', secret).update(signedPayload(t, body)).digest('hex');
    return { t, v1, header: `t=${t},v1=${v1}` };
}

/**
 * Reads `t=<seconds>,v1=<hex>`.
 *
 * Unknown fields are ignored rather than rejected: a future scheme adds `v2=` beside
 * `v1=`, and a verifier that refused the whole header would break on the day the
 * sender starts dual-signing. Split on the *first* `=` only, for the same reason.
 */
export function parseSignatureHeader(header: string): { t: number; v1: string } | null {
    let t: number | undefined;
    let v1: string | undefined;

    for (const part of header.split(',')) {
        const at = part.indexOf('=');
        if (at < 0) continue;
        const key = part.slice(0, at).trim();
        const value = part.slice(at + 1).trim();
        if (key === 't' && /^\d+$/.test(value)) t = Number(value);
        else if (key === 'v1') v1 = value;
    }

    return t === undefined || v1 === undefined ? null : { t, v1 };
}

export interface VerifyOptions {
    /** The raw request body, exactly as received. Re-serialising it changes bytes. */
    readonly body: string;
    readonly header: string;
    readonly secret: string;
    /** Seconds of clock skew tolerated in either direction. 0 disables the check. */
    readonly toleranceSeconds?: number | undefined;
    /** Unix milliseconds. Injected in tests. */
    readonly now?: (() => number) | undefined;
}

/**
 * Whether a request really came from a holder of the secret, and recently.
 *
 * The comparison is constant time, and the skew check is symmetric: a receiver whose
 * clock runs behind the sender's would otherwise accept requests from arbitrarily far
 * in the future, which is a replay window that never closes.
 */
export function verifySignature(options: VerifyOptions): boolean {
    const parsed = parseSignatureHeader(options.header);
    if (parsed === null) return false;

    const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    if (tolerance > 0) {
        const nowSeconds = (options.now ?? Date.now)() / 1000;
        if (Math.abs(nowSeconds - parsed.t) > tolerance) return false;
    }

    const expected = Buffer.from(signPayload(options.secret, options.body, parsed.t).v1, 'hex');
    // A malformed hex string decodes short instead of throwing, so the length is
    // checked before the compare rather than trusted.
    const actual = Buffer.from(parsed.v1, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}
