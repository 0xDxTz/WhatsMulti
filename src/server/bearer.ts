/**
 * Bearer-token authentication.
 *
 * Named `bearer` rather than `auth` so it cannot be confused with src/auth, which is
 * the Signal credential store and has nothing to do with this.
 *
 * The control plane starts sessions, sends messages and hands out QR codes. Whoever
 * reaches it can take over a WhatsApp account, so authentication is on by default and
 * turning it off is an explicit, named decision -- `insecure: true` -- rather than the
 * consequence of forgetting to pass a token.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import type { MiddlewareHandler } from 'hono';

import { WhatsMultiError } from '../errors.js';

import { toErrorResponse } from './http.js';

/** `Authorization: Bearer <token>`, or null. The scheme is matched case-insensitively. */
export function readBearer(header: string | null | undefined): string | null {
    if (typeof header !== 'string') return null;
    const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
    return match?.[1]?.trim() ?? null;
}

/**
 * Constant-time membership test.
 *
 * Both sides are hashed first so the comparison runs over equal-length digests: a
 * length check on the raw tokens would leak the length of the real one, and
 * `timingSafeEqual` throws on a mismatch rather than returning false. The loop never
 * breaks early, so the time taken does not depend on which token matched.
 */
export function tokenMatches(presented: string, accepted: readonly string[]): boolean {
    const digest = createHash('sha256').update(presented).digest();
    let matched = false;
    for (const token of accepted) {
        const expected = createHash('sha256').update(token).digest();
        if (timingSafeEqual(digest, expected)) matched = true;
    }
    return matched;
}

/**
 * Normalises the token options, refusing the configuration that looks secure and is
 * not: no token and no explicit opt-out.
 */
export function resolveTokens(token: string | readonly string[] | undefined, insecure: boolean): readonly string[] {
    const tokens = (typeof token === 'string' ? [token] : (token ?? [])).filter((value) => value.length > 0);

    if (tokens.length === 0) {
        if (!insecure) {
            throw new WhatsMultiError('INVALID_CONFIG', {
                params: {
                    path: 'server.token',
                    detail: 'refusing to serve without a bearer token; pass insecure: true to run unauthenticated',
                },
            });
        }
        return [];
    }

    if (insecure) {
        throw new WhatsMultiError('INVALID_CONFIG', {
            params: { path: 'server.insecure', detail: 'a token was given, so insecure would only weaken it' },
        });
    }
    return tokens;
}

/** Rejects with 401 and the Error shape. No tokens configured means no middleware. */
export function bearerAuth(tokens: readonly string[]): MiddlewareHandler {
    return async (c, next) => {
        const presented = readBearer(c.req.header('authorization'));

        if (presented === null || !tokenMatches(presented, tokens)) {
            // The same answer either way. Distinguishing "no token" from "wrong token"
            // tells a prober which half of the problem to work on.
            const { status, body } = toErrorResponse(new WhatsMultiError('UNAUTHORIZED'));
            // The challenge header is named so a client knows what to send (RFC 6750).
            return c.json(body, status, { 'www-authenticate': 'Bearer realm="whatsmulti"' });
        }

        await next();
        return undefined;
    };
}
