/**
 * The bridge between our errors and HTTP.
 *
 * The status for a code is `http` in spec/errors.yaml, generated into
 * ERROR_HTTP_STATUS. It lives in the spec rather than here so that an API client
 * branching on 409 versus 422 never has to ask whether it is talking to the
 * TypeScript build or the Go one.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { describeError, isWhatsMultiError, WhatsMultiError, type SerializedError } from '../errors.js';
import { ERROR_HTTP_STATUS } from '../generated/index.js';

export interface ErrorResponse {
    readonly status: ContentfulStatusCode;
    readonly body: SerializedError;
}

/**
 * Any throw, as the Error shape the contract promises.
 *
 * A foreign error becomes INTERNAL_ERROR rather than being labelled with whichever
 * of our codes happens to be nearby: a caller that reads `SESSION_FAILED` will go
 * looking at a session, and the failure may have had nothing to do with one.
 */
export function toErrorResponse(error: unknown): ErrorResponse {
    const wrapped = isWhatsMultiError(error)
        ? error
        : new WhatsMultiError('INTERNAL_ERROR', { params: { detail: describeError(error) }, cause: error });

    return { status: ERROR_HTTP_STATUS[wrapped.code] as ContentfulStatusCode, body: wrapped.toJSON() };
}

/** Rejects with INVALID_REQUEST rather than letting a parse error become a 500. */
export async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
    let parsed: unknown;
    try {
        parsed = await c.req.json();
    } catch (cause) {
        throw new WhatsMultiError('INVALID_REQUEST', {
            params: { detail: 'the body is not valid JSON' },
            cause,
        });
    }

    // An array is valid JSON and never a valid body here. Letting one through would
    // turn a client mistake into an undefined-property read three lines later.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new WhatsMultiError('INVALID_REQUEST', { params: { detail: 'the body must be a JSON object' } });
    }
    return parsed as Record<string, unknown>;
}

export function requiredString(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== 'string' || value.length === 0) {
        throw new WhatsMultiError('INVALID_REQUEST', { params: { detail: `${field} must be a non-empty string` } });
    }
    return value;
}

export function optionalObject(body: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new WhatsMultiError('INVALID_REQUEST', { params: { detail: `${field} must be an object` } });
    }
    return value as Record<string, unknown>;
}

export function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') {
        throw new WhatsMultiError('INVALID_REQUEST', { params: { detail: `${field} must be a boolean` } });
    }
    return value;
}
