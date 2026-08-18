import { describe, expect, it } from 'vitest';

import { WhatsMultiError } from '../../src/errors.js';
import { ERROR_HTTP_STATUS } from '../../src/generated/index.js';
import { readBearer, resolveTokens, tokenMatches } from '../../src/server/bearer.js';
import { toErrorResponse } from '../../src/server/http.js';

describe('readBearer', () => {
    it('reads the token', () => {
        expect(readBearer('Bearer secret')).toBe('secret');
    });

    it('is case-insensitive about the scheme and tolerant of spacing', () => {
        expect(readBearer('bearer secret')).toBe('secret');
        expect(readBearer('BEARER   secret  ')).toBe('secret');
        expect(readBearer('\tBearer\tsecret')).toBe('secret');
    });

    it.each([
        [null, 'absent'],
        [undefined, 'undefined'],
        ['', 'empty'],
        ['secret', 'no scheme'],
        ['Basic secret', 'the wrong scheme'],
        ['Bearer', 'no token'],
        ['Bearer ', 'a blank token'],
        ['Bearertoken', 'no separator'],
    ])('returns null for %s (%s)', (header, _label) => {
        expect(readBearer(header)).toBeNull();
    });
});

describe('tokenMatches', () => {
    it('accepts a configured token', () => {
        expect(tokenMatches('b', ['a', 'b', 'c'])).toBe(true);
    });

    it('rejects anything else', () => {
        expect(tokenMatches('d', ['a', 'b', 'c'])).toBe(false);
        expect(tokenMatches('a', [])).toBe(false);
    });

    it('compares tokens of unequal length without throwing', () => {
        // timingSafeEqual throws on a length mismatch, which is why both sides are
        // hashed first: the comparison always runs over two 32-byte digests, and the
        // length of the real token never leaks.
        expect(tokenMatches('short', ['a-much-longer-configured-token'])).toBe(false);
        expect(tokenMatches('a-much-longer-presented-token', ['x'])).toBe(false);
    });

    it('is exact', () => {
        expect(tokenMatches('secret ', ['secret'])).toBe(false);
        expect(tokenMatches('SECRET', ['secret'])).toBe(false);
        expect(tokenMatches('secretsecret', ['secret'])).toBe(false);
    });
});

describe('resolveTokens', () => {
    it('accepts a single token or a list', () => {
        expect(resolveTokens('a', false)).toEqual(['a']);
        expect(resolveTokens(['a', 'b'], false)).toEqual(['a', 'b']);
    });

    it('drops empty strings', () => {
        expect(resolveTokens(['a', ''], false)).toEqual(['a']);
    });

    it('refuses to serve unauthenticated by accident', () => {
        // Whoever reaches this API can take over a WhatsApp account. Running it open
        // has to be a decision someone typed, not the result of forgetting a token.
        expect(() => resolveTokens(undefined, false)).toThrow(
            expect.objectContaining({ code: 'INVALID_CONFIG' }) as Error
        );
        expect(() => resolveTokens([], false)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }) as Error);
        expect(() => resolveTokens([''], false)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }) as Error);
    });

    it('allows it when it is asked for explicitly', () => {
        expect(resolveTokens(undefined, true)).toEqual([]);
    });

    it('refuses a token and insecure together', () => {
        // The two contradict, and guessing which one was meant is how a deployment
        // ends up open while its config says otherwise.
        expect(() => resolveTokens('a', true)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }) as Error);
    });
});

describe('toErrorResponse', () => {
    it.each([
        ['SESSION_NOT_FOUND', 404],
        ['SESSION_EXISTS', 409],
        ['INVALID_SESSION_ID', 422],
        ['SEND_FAILED', 503],
        ['MISSING_PEER', 501],
        ['TIMEOUT', 504],
        ['UNAUTHORIZED', 401],
        ['ROUTE_NOT_FOUND', 404],
    ] as const)('maps %s to %i, from the spec', (code, status) => {
        expect(ERROR_HTTP_STATUS[code]).toBe(status);
        expect(toErrorResponse(new WhatsMultiError(code)).status).toBe(status);
    });

    it('carries the code, the message and the session id', () => {
        const error = new WhatsMultiError('SESSION_NOT_FOUND', { sessionId: 's1', params: { sessionId: 's1' } });
        expect(toErrorResponse(error).body).toEqual({
            code: 'SESSION_NOT_FOUND',
            message: 'Session s1 is not registered',
            sessionId: 's1',
        });
    });

    it('labels a foreign throw INTERNAL_ERROR rather than borrowing a nearby code', () => {
        // A caller that reads SESSION_FAILED goes looking at a session, and this
        // failure may have had nothing to do with one.
        const { status, body } = toErrorResponse(new TypeError('boom'));
        expect(status).toBe(500);
        expect(body.code).toBe('INTERNAL_ERROR');
        expect(body.message).toContain('boom');
    });

    it('handles a throw that is not an Error at all', () => {
        expect(toErrorResponse('just a string').body.message).toContain('just a string');
    });
});
