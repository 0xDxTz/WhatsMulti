/**
 * The bridge between our logger and the driver's.
 *
 * Lives in compat because it is the driver's interface we are conforming to, and
 * because both the socket factory and the media downloader need it -- routing the
 * second through the first would point the messaging layer at the session layer for
 * no reason.
 */
import type { ILogger } from './baileys.js';
import type { Logger, LogLevel } from '../logger.js';

/**
 * Adapts our logger to the driver's.
 *
 * The two interfaces are nearly identical -- both are pino-shaped -- but the driver
 * also reads `.level`, and its methods are `(obj, msg?)` only, where ours also accept
 * a bare message. The forwarding below picks the right overload so a plain string
 * from the driver does not end up serialised as an object.
 */
export function toDriverLogger(logger: Logger, level: LogLevel): ILogger {
    const forward =
        (write: Logger['info']) =>
        (obj: unknown, msg?: string): void => {
            if (typeof obj === 'string') write(msg === undefined ? obj : `${obj} ${msg}`);
            else if (msg === undefined) write(obj as object);
            else write(obj as object, msg);
        };

    return {
        level,
        child: (bindings) => toDriverLogger(logger.child(bindings), level),
        trace: forward(logger.trace),
        debug: forward(logger.debug),
        info: forward(logger.info),
        warn: forward(logger.warn),
        error: forward(logger.error),
    };
}
