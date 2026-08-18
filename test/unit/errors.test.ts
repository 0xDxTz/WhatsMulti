import { describe, expect, it } from 'vitest';

import {
    describeError,
    formatErrorMessage,
    hasErrorCode,
    isWhatsMultiError,
    WhatsMultiError,
    wrapError,
} from '../../src/errors.js';
import { ERROR_CODES, ERROR_RETRYABLE } from '../../src/generated/index.js';

describe('formatErrorMessage', () => {
    it('substitutes placeholders', () => {
        expect(formatErrorMessage('SESSION_NOT_FOUND', { sessionId: 'a' })).toBe('Session a is not registered');
    });

    it('joins array parameters', () => {
        const message = formatErrorMessage('SESSION_NOT_READY', {
            sessionId: 'a',
            state: 'closed',
            expected: ['open', 'connecting'],
        });
        expect(message).toBe('Session a is closed, expected one of open, connecting');
    });

    it('leaves an unmatched placeholder intact rather than printing undefined', () => {
        // A visible {state} in a bug report points at the missing parameter;
        // "undefined" just looks like a value.
        expect(formatErrorMessage('SESSION_NOT_READY', { sessionId: 'a' })).toContain('{state}');
        expect(formatErrorMessage('SESSION_NOT_READY', { sessionId: 'a' })).not.toContain('undefined');
    });

    it('renders every code without throwing', () => {
        for (const code of ERROR_CODES) expect(typeof formatErrorMessage(code)).toBe('string');
    });
});

describe('WhatsMultiError', () => {
    it('carries the code, retryable flag and sessionId', () => {
        const error = new WhatsMultiError('SESSION_LOCKED', {
            sessionId: 'a',
            params: { sessionId: 'a', owner: 'host:1:abc' },
        });
        expect(error.code).toBe('SESSION_LOCKED');
        expect(error.retryable).toBe(true);
        expect(error.sessionId).toBe('a');
        expect(error.message).toBe('Session a is held by instance host:1:abc');
        expect(error.name).toBe('WhatsMultiError');
        expect(error).toBeInstanceOf(Error);
    });

    it('preserves the original error as cause', () => {
        const cause = new Error('socket hang up');
        expect(new WhatsMultiError('STORAGE_ERROR', { cause }).cause).toBe(cause);
    });

    it('omits cause when none was supplied', () => {
        expect('cause' in new WhatsMultiError('CLIENT_DESTROYED')).toBe(false);
    });

    it('takes its retryable flag from the spec', () => {
        for (const code of ERROR_CODES) {
            expect(new WhatsMultiError(code).retryable, code).toBe(ERROR_RETRYABLE[code]);
        }
    });

    it('serialises to the shape the REST and webhook contracts declare', () => {
        expect(new WhatsMultiError('TIMEOUT', { sessionId: 'a' }).toJSON()).toEqual({
            code: 'TIMEOUT',
            message: expect.any(String) as string,
            sessionId: 'a',
        });
        expect(new WhatsMultiError('TIMEOUT').toJSON()).not.toHaveProperty('sessionId');
    });
});

describe('guards', () => {
    it('isWhatsMultiError rejects foreign errors', () => {
        expect(isWhatsMultiError(new WhatsMultiError('TIMEOUT'))).toBe(true);
        expect(isWhatsMultiError(new Error('nope'))).toBe(false);
        expect(isWhatsMultiError(undefined)).toBe(false);
    });

    it('hasErrorCode narrows to one code', () => {
        const error: unknown = new WhatsMultiError('SESSION_EXISTS');
        expect(hasErrorCode(error, 'SESSION_EXISTS')).toBe(true);
        expect(hasErrorCode(error, 'SESSION_NOT_FOUND')).toBe(false);
    });
});

describe('wrapError', () => {
    it('wraps a foreign error', () => {
        const cause = new Error('ECONNREFUSED');
        const wrapped = wrapError('STORAGE_ERROR', cause, { params: { adapter: 'mongo' } });
        expect(wrapped.code).toBe('STORAGE_ERROR');
        expect(wrapped.cause).toBe(cause);
    });

    it('passes our own errors straight through so the original code survives', () => {
        const original = new WhatsMultiError('SESSION_NOT_FOUND', { sessionId: 'a' });
        expect(wrapError('STORAGE_ERROR', original)).toBe(original);
    });
});

describe('describeError', () => {
    it.each([
        [new Error('boom'), 'boom'],
        ['plain string', 'plain string'],
        [{ a: 1 }, '{"a":1}'],
        [undefined, undefined],
    ])('describes %o', (input, expected) => {
        expect(describeError(input)).toBe(expected ?? String(input));
    });

    it('survives a circular value', () => {
        const circular: Record<string, unknown> = {};
        circular['self'] = circular;
        expect(() => describeError(circular)).not.toThrow();
    });
});
