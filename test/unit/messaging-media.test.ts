import { Transform } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MediaDownloadOptions, WAMessage, WASocket } from '../../src/compat/baileys.js';
import { setDriverLoader, type BaileysModule } from '../../src/compat/driver.js';
import type { WhatsMultiError } from '../../src/errors.js';
import { downloadMedia, downloadMediaStream } from '../../src/messaging/media.js';

afterEach(() => {
    setDriverLoader(null);
});

const message = { key: { id: 'MSG1' } } as unknown as WAMessage;

type DownloadArgs = [WAMessage, 'buffer' | 'stream', MediaDownloadOptions, unknown];

function stubDriver(result: unknown = Buffer.from('media')) {
    const downloadMediaMessage = vi.fn((..._args: DownloadArgs) =>
        result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    );
    setDriverLoader(() => Promise.resolve({ downloadMediaMessage } as unknown as BaileysModule));
    return downloadMediaMessage;
}

const socketWith = () => {
    const updateMediaMessage = vi.fn((msg: WAMessage) => Promise.resolve(msg));
    return { socket: { updateMediaMessage } as unknown as WASocket, updateMediaMessage };
};

describe('downloadMedia', () => {
    it('returns the bytes the driver produced', async () => {
        stubDriver(Buffer.from('hello'));

        const bytes = await downloadMedia({ sessionId: 's1', message });

        expect(bytes.toString()).toBe('hello');
    });

    it('asks the driver for a buffer', async () => {
        const download = stubDriver();

        await downloadMedia({ sessionId: 's1', message });

        expect(download.mock.calls[0]?.[1]).toBe('buffer');
    });

    it('hands the driver a way to refresh an expired URL', async () => {
        // WhatsApp serves media from a signed URL that expires. Without a
        // reuploadRequest every expired attachment is a permanent failure, which is
        // the most common way media handling is written wrong.
        const download = stubDriver();
        const { socket } = socketWith();

        await downloadMedia({ sessionId: 's1', message, socket });

        const ctx = download.mock.calls[0]?.[3] as { reuploadRequest: unknown; logger: unknown };
        expect(typeof ctx.reuploadRequest).toBe('function');
        expect(ctx.logger).toBeDefined();
    });

    it('actually calls back into the socket to refresh', async () => {
        const download = stubDriver();
        const { socket, updateMediaMessage } = socketWith();
        await downloadMedia({ sessionId: 's1', message, socket });

        const ctx = download.mock.calls[0]?.[3] as { reuploadRequest: (msg: WAMessage) => Promise<WAMessage> };
        await ctx.reuploadRequest(message);

        expect(updateMediaMessage).toHaveBeenCalledWith(message);
    });

    it('omits the context when no socket is available', async () => {
        const download = stubDriver();

        await downloadMedia({ sessionId: 's1', message });

        expect(download.mock.calls[0]?.[3]).toBeUndefined();
    });

    it('forwards range options', async () => {
        const download = stubDriver();

        await downloadMedia({ sessionId: 's1', message, options: { startByte: 10, endByte: 20 } });

        expect(download.mock.calls[0]?.[2]).toEqual({ startByte: 10, endByte: 20 });
    });

    it('wraps a failure as MEDIA_DOWNLOAD_FAILED, naming the message', async () => {
        stubDriver(new Error('404 from media host'));

        const error = (await downloadMedia({ sessionId: 's1', message }).catch((e: unknown) => e)) as WhatsMultiError;

        expect(error.code).toBe('MEDIA_DOWNLOAD_FAILED');
        expect(error.sessionId).toBe('s1');
        expect(error.message).toContain('MSG1');
        expect(error.message).toContain('404 from media host');
    });

    it('copes with a message that has no id', async () => {
        stubDriver(new Error('nope'));

        await expect(
            downloadMedia({ sessionId: 's1', message: { key: {} } as unknown as WAMessage })
        ).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED' });
    });

    it('has no deadline by default, because transfers are legitimately slow', async () => {
        const download = vi.fn(() => new Promise<Buffer>((resolve) => setTimeout(() => resolve(Buffer.of(1)), 20)));
        setDriverLoader(() => Promise.resolve({ downloadMediaMessage: download } as unknown as BaileysModule));

        await expect(downloadMedia({ sessionId: 's1', message })).resolves.toHaveLength(1);
    });

    it('applies a deadline when one is asked for, and keeps it a TIMEOUT', async () => {
        // Not re-labelled as a download failure: a deadline is not a cancellation, so
        // the transfer may still be running, and the caller needs to know the
        // difference before retrying.
        setDriverLoader(() =>
            Promise.resolve({
                downloadMediaMessage: () => new Promise<never>(() => undefined),
            } as unknown as BaileysModule)
        );

        await expect(downloadMedia({ sessionId: 's1', message, timeoutMs: 5 })).rejects.toMatchObject({
            code: 'TIMEOUT',
        });
    });

    it('reports a missing driver as MISSING_PEER', async () => {
        setDriverLoader(() => Promise.reject(new Error('not installed')));

        await expect(downloadMedia({ sessionId: 's1', message })).rejects.toMatchObject({ code: 'MISSING_PEER' });
    });
});

describe('downloadMediaStream', () => {
    it('asks the driver for a stream and returns it', async () => {
        const stream = new Transform({ transform: (chunk, _enc, done) => done(null, chunk) });
        const download = stubDriver(stream);

        const result = await downloadMediaStream({ sessionId: 's1', message });

        expect(result).toBe(stream);
        expect(download.mock.calls[0]?.[1]).toBe('stream');
    });
});
