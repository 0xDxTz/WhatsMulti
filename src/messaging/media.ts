/**
 * Downloading media attached to a message.
 *
 * A thin wrapper, but not a pointless one. WhatsApp serves media from a signed URL
 * that expires, and the only way to recover is to ask the server to re-upload it --
 * which the driver will do, but only if it is handed a `reuploadRequest`. Calling
 * `downloadMediaMessage` without one turns every expired attachment into a permanent
 * failure, which is the single most common way media handling is written wrong.
 */
import type { Transform } from 'node:stream';

import type { MediaDownloadOptions, WAMessage, WASocket } from '../compat/baileys.js';
import { loadDriver } from '../compat/driver.js';
import { toDriverLogger } from '../compat/driver-logger.js';
import { describeError, wrapError } from '../errors.js';
import { silentLogger, type Logger } from '../logger.js';
import { withTimeout } from '../utils/timeout.js';

export interface DownloadRequest {
    readonly sessionId: string;
    readonly message: WAMessage;
    /**
     * The session's socket. Optional, but without it an expired media URL cannot be
     * refreshed and the download fails permanently.
     */
    readonly socket?: WASocket | undefined;
    readonly logger?: Logger | undefined;
    readonly options?: MediaDownloadOptions | undefined;
    /** 0, the default, means no deadline. Media transfers are legitimately slow. */
    readonly timeoutMs?: number | undefined;
}

const messageId = (message: WAMessage): string => message.key.id ?? 'unknown';

async function download<T extends 'buffer' | 'stream'>(
    request: DownloadRequest,
    type: T
): Promise<T extends 'buffer' ? Buffer : Transform> {
    const driver = await loadDriver();
    const logger = request.logger ?? silentLogger;

    const ctx =
        request.socket === undefined
            ? undefined
            : {
                  reuploadRequest: request.socket.updateMediaMessage.bind(request.socket),
                  logger: toDriverLogger(logger, 'silent'),
              };

    try {
        return await withTimeout(driver.downloadMediaMessage(request.message, type, request.options ?? {}, ctx), {
            operation: `download media ${messageId(request.message)}`,
            timeoutMs: request.timeoutMs ?? 0,
            sessionId: request.sessionId,
        });
    } catch (cause) {
        throw wrapError('MEDIA_DOWNLOAD_FAILED', cause, {
            sessionId: request.sessionId,
            params: {
                sessionId: request.sessionId,
                messageId: messageId(request.message),
                detail: describeError(cause),
            },
        });
    }
}

/** The whole attachment in memory. Prefer the stream for anything large. */
export function downloadMedia(request: DownloadRequest): Promise<Buffer> {
    return download(request, 'buffer');
}

/** A stream, so a large attachment never has to be held in memory at once. */
export function downloadMediaStream(request: DownloadRequest): Promise<Transform> {
    return download(request, 'stream');
}
