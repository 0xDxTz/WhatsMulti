/**
 * Assembles the driver socket for one session.
 *
 * Everything version-specific about `makeWASocket` lives here, so a Baileys RC bump
 * touches this file and `compat/`, not the session logic. It is also the seam the
 * tests replace: `Session` takes a factory, so the whole lifecycle can be exercised
 * against a scripted stand-in with no network.
 */
import type { AuthenticationState, SocketConfig, UserFacingSocketConfig, WASocket } from '../compat/baileys.js';
import { loadDriver, type BaileysModule } from '../compat/driver.js';
import { toDriverLogger } from '../compat/driver-logger.js';
import type { ResolvedConfig } from '../config.js';
import type { Logger } from '../logger.js';

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
