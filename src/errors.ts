import { ERROR_MESSAGES, ERROR_RETRYABLE, type ErrorCode } from './generated/index.js';

export type { ErrorCode };

/** Values substituted into an error's `{placeholder}` slots. */
export type ErrorParams = Readonly<Record<string, string | number | boolean | readonly (string | number)[]>>;

export interface WhatsMultiErrorOptions {
    readonly params?: ErrorParams;
    readonly sessionId?: string;
    readonly cause?: unknown;
}

/** Shape used by the REST control plane and the webhook envelope. */
export interface SerializedError {
    readonly code: ErrorCode;
    readonly message: string;
    readonly sessionId?: string;
}

const PLACEHOLDER = /\{(\w+)\}/g;

const render = (value: ErrorParams[string]): string => (Array.isArray(value) ? value.join(', ') : String(value));

/**
 * Fills a template from spec/errors.yaml. An unmatched placeholder is left intact
 * rather than rendered as "undefined" -- a visible `{state}` in a bug report points
 * straight at the missing parameter.
 */
export function formatErrorMessage(code: ErrorCode, params: ErrorParams = {}): string {
    return ERROR_MESSAGES[code].replace(PLACEHOLDER, (whole, key: string) => {
        const value = params[key];
        return value === undefined ? whole : render(value);
    });
}

/**
 * Every error this library throws. `code` is public API -- branch on it, never on
 * the message text. v1 threw bare `new Error('Session exists')` and its own README
 * documented string-matching as the way to handle it.
 */
export class WhatsMultiError extends Error {
    readonly code: ErrorCode;
    readonly retryable: boolean;
    readonly sessionId: string | undefined;
    readonly params: ErrorParams;

    constructor(code: ErrorCode, options: WhatsMultiErrorOptions = {}) {
        super(
            formatErrorMessage(code, options.params),
            options.cause === undefined ? undefined : { cause: options.cause }
        );
        this.name = 'WhatsMultiError';
        this.code = code;
        this.retryable = ERROR_RETRYABLE[code];
        this.sessionId = options.sessionId;
        this.params = options.params ?? {};

        /* c8 ignore next 3 -- V8-only, absent on other engines */
        if (typeof Error.captureStackTrace === 'function') {
            Error.captureStackTrace(this, WhatsMultiError);
        }
    }

    toJSON(): SerializedError {
        return this.sessionId === undefined
            ? { code: this.code, message: this.message }
            : { code: this.code, message: this.message, sessionId: this.sessionId };
    }
}

export function isWhatsMultiError(value: unknown): value is WhatsMultiError {
    return value instanceof WhatsMultiError;
}

/** Narrows to a specific code, for `catch` blocks that handle one failure. */
export function hasErrorCode<C extends ErrorCode>(value: unknown, code: C): value is WhatsMultiError & { code: C } {
    return isWhatsMultiError(value) && value.code === code;
}

/**
 * Wraps a foreign error, preserving it as `cause`. Re-wrapping one of our own errors
 * would bury the original code, so it is passed through untouched.
 */
export function wrapError(code: ErrorCode, cause: unknown, options: Omit<WhatsMultiErrorOptions, 'cause'> = {}) {
    if (isWhatsMultiError(cause)) return cause;
    return new WhatsMultiError(code, { ...options, cause });
}

/** Best-effort description of an unknown throw, for log lines and error params. */
export function describeError(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}
