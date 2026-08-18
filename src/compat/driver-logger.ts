/**
 * The bridge between our logger and the driver's.
 *
 * Lives in compat because it is the driver's interface we are conforming to, and
 * because both the socket factory and the media downloader need it -- routing the
 * second through the first would point the messaging layer at the session layer for
 * no reason.
 */
import type { ILogger } from './baileys.js';
import { levelEnabled, type Logger, type LogLevel } from '../logger.js';

/**
 * Adapts our logger to the driver's.
 *
 * The two interfaces are nearly identical -- both are pino-shaped -- but the driver
 * also reads `.level`, and its methods are `(obj, msg?)` only, where ours also accept
 * a bare message. The forwarding below picks the right overload so a plain string
 * from the driver does not end up serialised as an object.
 *
 * The filtering is ours to do. A pino instance drops a call below its own level
 * internally; this bridge is a plain object, and the driver calls `info()` whether or
 * not it has read `.level` first. Without the gate, `driverLogLevel: 'silent'` -- the
 * default -- would still put every handshake line the driver writes onto our logger,
 * which is exactly the shape of the v1 defect where a declared log level did nothing.
 */
export function toDriverLogger(logger: Logger, level: LogLevel): ILogger {
    const forward =
        (write: Logger['info'], at: LogLevel) =>
        (obj: unknown, msg?: string): void => {
            if (!levelEnabled(level, at)) return;
            if (typeof obj === 'string') write(msg === undefined ? obj : `${obj} ${msg}`);
            else if (msg === undefined) write(obj as object);
            else write(obj as object, msg);
        };

    return {
        level,
        child: (bindings) => toDriverLogger(logger.child(bindings), level),
        trace: forward(logger.trace, 'trace'),
        debug: forward(logger.debug, 'debug'),
        info: forward(logger.info, 'info'),
        warn: forward(logger.warn, 'warn'),
        error: forward(logger.error, 'error'),
    };
}
