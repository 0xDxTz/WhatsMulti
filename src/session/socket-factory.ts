/**
 * Assembles the driver socket for one session.
 *
 * Everything version-specific about `makeWASocket` lives here, so a Baileys RC bump
 * touches this file and `compat/`, not the session logic. It is also the seam the
 * tests replace: `Session` takes a factory, so the whole lifecycle can be exercised
 * against a scripted stand-in with no network.
 */
import type {
    AuthenticationState,
    ILogger,
    SocketConfig,
    UserFacingSocketConfig,
    WASocket,
} from '../compat/baileys.js';
import { loadDriver, type BaileysModule } from '../compat/driver.js';
import type { ResolvedConfig } from '../config.js';
import type { Logger, LogLevel } from '../logger.js';

export interface SocketFactoryOptions {
    readonly sessionId: string;
    readonly auth: AuthenticationState;
    readonly config: ResolvedConfig;
    readonly logger: Logger;
    /** Passed straight to the driver. Anything set here wins over our defaults. */
    readonly socketOptions?: Partial<SocketConfig> | undefined;
}

export type SocketFactory = (options: SocketFactoryOptions) => Promise<WASocket>;

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

/**
 * The driver options we set ourselves, before `socketOptions` is layered on top.
 *
 * Deliberately short. Every key here exists because leaving it to the driver default
 * would be wrong for a multi-session library, and everything else stays the
 * consumer's decision.
 */
export function buildSocketConfig(
    options: SocketFactoryOptions,
    driver: Pick<BaileysModule, 'Browsers'>,
    keys: AuthenticationState['keys']
): UserFacingSocketConfig {
    const { config } = options;

    return {
        auth: { creds: options.auth.creds, keys },
        logger: toDriverLogger(options.logger, config.driverLogLevel),
        // v1 declared qrTimeoutMs in its types and never read it.
        qrTimeout: config.qr.timeoutMs,
        // Pairing by phone code is rejected unless the browser description is a
        // desktop one; the driver's default is not.
        ...(config.pairing.enabled ? { browser: driver.Browsers.ubuntu('Chrome') } : {}),
        ...options.socketOptions,
    };
}

/**
 * Opens a socket. Note there is no `printQRInTerminal`: Baileys v7 removed it, and QR
 * rendering is ours to do lazily behind the optional renderer.
 */
export const createSocket: SocketFactory = async (options) => {
    const driver = await loadDriver();

    // The driver's own read-through cache in front of our storage. Resuming a session
    // asks for the same Signal keys repeatedly, and a cache hit is a storage round
    // trip that never happens.
    const keys = driver.makeCacheableSignalKeyStore(
        options.auth.keys,
        toDriverLogger(options.logger, options.config.driverLogLevel)
    );

    return driver.makeWASocket(buildSocketConfig(options, driver, keys));
};
