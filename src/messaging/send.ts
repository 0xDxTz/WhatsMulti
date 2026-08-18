/**
 * The send path.
 *
 * Kept separate from the queue and from `Session` so that everything that can go
 * wrong with one message -- a bad recipient, a socket that went away, a driver that
 * hangs, a driver that returns nothing -- is handled in one readable place, and so
 * failures reach the caller as a typed SEND_FAILED instead of whatever the driver
 * happened to throw.
 *
 * v1 threw bare `new Error('...')` strings here and documented string matching as the
 * way to handle them.
 */
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage, WASocket } from '../compat/baileys.js';
import { describeError, WhatsMultiError, wrapError } from '../errors.js';
import { withTimeout } from '../utils/timeout.js';

import { normalizeJid } from './jid.js';

export interface SendRequest {
    readonly sessionId: string;
    readonly socket: WASocket;
    /** A JID or a phone number; normalised before it reaches the driver. */
    readonly to: string;
    readonly content: AnyMessageContent;
    /** 0 disables the deadline. */
    readonly timeoutMs: number;
    readonly options?: MiscMessageGenerationOptions | undefined;
}

/**
 * Sends one message.
 *
 * The timeout is a deadline, not a cancellation: the driver call keeps running, so a
 * message that timed out may still be delivered. Retrying after one risks a
 * duplicate, which is why TIMEOUT and SEND_FAILED are distinct codes rather than one
 * generic failure.
 */
export async function sendMessage(request: SendRequest): Promise<WAMessage> {
    const jid = normalizeJid(request.to);

    let sent: WAMessage | undefined;
    try {
        sent = await withTimeout(request.socket.sendMessage(jid, request.content, request.options), {
            operation: `send to ${jid}`,
            timeoutMs: request.timeoutMs,
            sessionId: request.sessionId,
        });
    } catch (cause) {
        throw wrapError('SEND_FAILED', cause, {
            sessionId: request.sessionId,
            params: { sessionId: request.sessionId, detail: describeError(cause) },
        });
    }

    // The driver returns undefined when it declined to send at all. Resolving with it
    // would hand the caller a "sent" message that has no id and never existed.
    if (sent === undefined) {
        throw new WhatsMultiError('SEND_FAILED', {
            sessionId: request.sessionId,
            params: { sessionId: request.sessionId, detail: `the driver did not produce a message for ${jid}` },
        });
    }

    return sent;
}
