import { describe, expect, it, vi } from 'vitest';

import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage, WASocket } from '../../src/compat/baileys.js';
import { WhatsMultiError } from '../../src/errors.js';
import { sendMessage } from '../../src/messaging/send.js';
import { withTimeout } from '../../src/utils/timeout.js';

const message = { key: { id: 'MSG1' } } as unknown as WAMessage;

function socketWith(
    send: (
        jid: string,
        content: AnyMessageContent,
        options?: MiscMessageGenerationOptions
    ) => Promise<WAMessage | undefined>
) {
    const sendMock = vi.fn(send);
    return { socket: { sendMessage: sendMock } as unknown as WASocket, sendMock };
}

const request = (socket: WASocket, to = '628123456789', timeoutMs = 0) => ({
    sessionId: 's1',
    socket,
    to,
    content: { text: 'hi' } as AnyMessageContent,
    timeoutMs,
});

describe('withTimeout', () => {
    it('passes the value through when the work finishes in time', async () => {
        await expect(withTimeout(Promise.resolve(1), { operation: 'op', timeoutMs: 1000 })).resolves.toBe(1);
    });

    it('passes a rejection through untouched', async () => {
        const boom = new Error('nope');

        await expect(withTimeout(Promise.reject(boom), { operation: 'op', timeoutMs: 1000 })).rejects.toBe(boom);
    });

    it('rejects with TIMEOUT once the deadline passes', async () => {
        const never = new Promise<never>(() => undefined);

        const error = (await withTimeout(never, { operation: 'send', timeoutMs: 5, sessionId: 's1' }).catch(
            (e: unknown) => e
        )) as WhatsMultiError;

        expect(error.code).toBe('TIMEOUT');
        expect(error.sessionId).toBe('s1');
        expect(error.message).toContain('send');
        expect(error.message).toContain('5ms');
    });

    it('treats a non-positive timeout as no deadline', async () => {
        await expect(withTimeout(Promise.resolve('ok'), { operation: 'op', timeoutMs: 0 })).resolves.toBe('ok');
    });

    it('clears the timer so a pending one cannot hold the process open', async () => {
        const clear = vi.spyOn(globalThis, 'clearTimeout');

        await withTimeout(Promise.resolve('ok'), { operation: 'op', timeoutMs: 10_000 });

        expect(clear).toHaveBeenCalled();
        clear.mockRestore();
    });
});

describe('sendMessage', () => {
    it('normalises the recipient before handing it to the driver', async () => {
        const { socket, sendMock } = socketWith(() => Promise.resolve(message));

        await sendMessage(request(socket, '+62 812-3456-789'));

        expect(sendMock).toHaveBeenCalledWith('628123456789@s.whatsapp.net', { text: 'hi' }, undefined);
    });

    it('accepts a JID unchanged', async () => {
        const { socket, sendMock } = socketWith(() => Promise.resolve(message));

        await sendMessage(request(socket, '120363000000000000@g.us'));

        expect(sendMock.mock.calls[0]?.[0]).toBe('120363000000000000@g.us');
    });

    it('returns what the driver produced', async () => {
        const { socket } = socketWith(() => Promise.resolve(message));

        await expect(sendMessage(request(socket))).resolves.toBe(message);
    });

    it('forwards the driver options', async () => {
        const { socket, sendMock } = socketWith(() => Promise.resolve(message));

        await sendMessage({ ...request(socket), options: { ephemeralExpiration: 60 } });

        expect(sendMock.mock.calls[0]?.[2]).toEqual({ ephemeralExpiration: 60 });
    });

    it('rejects an unusable recipient before touching the socket', async () => {
        const { socket, sendMock } = socketWith(() => Promise.resolve(message));

        await expect(sendMessage(request(socket, '0812345678'))).rejects.toMatchObject({
            code: 'INVALID_PHONE_NUMBER',
        });
        expect(sendMock).not.toHaveBeenCalled();
    });

    it('wraps a driver failure as SEND_FAILED, keeping the reason', async () => {
        // v1 threw bare Error strings here and documented string matching as the way
        // to handle them.
        const { socket } = socketWith(() => Promise.reject(new Error('rate-overlimit')));

        const error = (await sendMessage(request(socket)).catch((e: unknown) => e)) as WhatsMultiError;

        expect(error.code).toBe('SEND_FAILED');
        expect(error.sessionId).toBe('s1');
        expect(error.message).toContain('rate-overlimit');
        expect(error.cause).toBeInstanceOf(Error);
    });

    it('fails when the driver declines to produce a message', async () => {
        // Resolving with undefined would hand the caller a "sent" message that has no
        // id and never existed.
        const { socket } = socketWith(() => Promise.resolve(undefined));

        await expect(sendMessage(request(socket))).rejects.toMatchObject({
            code: 'SEND_FAILED',
            message: expect.stringContaining('did not produce a message') as unknown as string,
        });
    });

    it('reports a hung driver as TIMEOUT, not as SEND_FAILED', async () => {
        // The two are distinct because a timeout is a deadline, not a cancellation:
        // the message may still be delivered, so retrying risks a duplicate.
        const { socket } = socketWith(() => new Promise<never>(() => undefined));

        const error = (await sendMessage(request(socket, '628123456789', 5)).catch(
            (e: unknown) => e
        )) as WhatsMultiError;

        expect(error.code).toBe('TIMEOUT');
    });

    it('keeps one of our own errors intact rather than double-wrapping it', async () => {
        const inner = new WhatsMultiError('SESSION_LOGGED_OUT', { params: { sessionId: 's1' } });
        const { socket } = socketWith(() => Promise.reject(inner));

        await expect(sendMessage(request(socket))).rejects.toBe(inner);
    });
});
