import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticationState, UserFacingSocketConfig, WASocket } from '../../src/compat/baileys.js';
import { setDriverLoader, type BaileysModule } from '../../src/compat/driver.js';
import { DEFAULT_CONFIG, type ResolvedConfig } from '../../src/config.js';
import type { Logger } from '../../src/logger.js';
import { toDriverLogger } from '../../src/compat/driver-logger.js';
import { buildSocketConfig, createSocket } from '../../src/session/socket-factory.js';

afterEach(() => {
    setDriverLoader(null);
});

const recordingLogger = () => {
    const calls: [string, unknown, string | undefined][] = [];
    const make = (level: string) => ((obj: unknown, msg?: string) => calls.push([level, obj, msg])) as Logger['info'];
    const logger: Logger = {
        error: make('error'),
        warn: make('warn'),
        info: make('info'),
        debug: make('debug'),
        trace: make('trace'),
        child: (bindings) => ({ ...logger, bindings }) as unknown as Logger,
    };
    return { logger, calls };
};

const auth = () =>
    ({
        creds: { registrationId: 7 },
        keys: { get: () => ({}), set: () => undefined },
    }) as unknown as AuthenticationState;

const options = (config: ResolvedConfig = DEFAULT_CONFIG, socketOptions?: Partial<UserFacingSocketConfig>) => ({
    sessionId: 's1',
    auth: auth(),
    config,
    logger: recordingLogger().logger,
    ...(socketOptions === undefined ? {} : { socketOptions }),
});

const browsers = { Browsers: { ubuntu: (name: string) => ['Ubuntu', name, '22.04'] } } as Pick<
    BaileysModule,
    'Browsers'
>;

describe('toDriverLogger', () => {
    it('exposes the level the driver reads', () => {
        expect(toDriverLogger(recordingLogger().logger, 'debug').level).toBe('debug');
    });

    it('forwards an object and a message', () => {
        const { logger, calls } = recordingLogger();

        toDriverLogger(logger, 'trace').warn({ a: 1 }, 'careful');

        expect(calls).toEqual([['warn', { a: 1 }, 'careful']]);
    });

    it('forwards a bare object', () => {
        const { logger, calls } = recordingLogger();

        toDriverLogger(logger, 'trace').debug({ a: 1 });

        expect(calls).toEqual([['debug', { a: 1 }, undefined]]);
    });

    it('keeps a driver string as a message, not as a serialised object', () => {
        // The driver's methods are (obj, msg?) only, so a plain string arrives in the
        // first slot. Passing it through unchanged would log `"..."` as JSON.
        const { logger, calls } = recordingLogger();

        toDriverLogger(logger, 'trace').info('connected');

        expect(calls).toEqual([['info', 'connected', undefined]]);
    });

    it('joins a string pair rather than dropping half of it', () => {
        const { logger, calls } = recordingLogger();

        toDriverLogger(logger, 'trace').error('stream', 'errored');

        expect(calls).toEqual([['error', 'stream errored', undefined]]);
    });

    it('keeps the level across child loggers', () => {
        const child = toDriverLogger(recordingLogger().logger, 'warn').child({ scope: 'ws' });

        expect(child.level).toBe('warn');
        expect(typeof child.child).toBe('function');
    });

    it('drops everything at the silent default', () => {
        // The default. Baileys logs the handshake, the registration attempt and every
        // stream event at info; none of it belongs on a consumer's logger unless they
        // asked for it. The driver calls the method regardless of `.level`, so the
        // gate has to live here.
        const { logger, calls } = recordingLogger();
        const driverLogger = toDriverLogger(logger, 'silent');

        driverLogger.error({}, 'e');
        driverLogger.warn({}, 'w');
        driverLogger.info({}, 'i');

        expect(calls).toEqual([]);
    });

    it('passes what the configured level allows and drops the rest', () => {
        const { logger, calls } = recordingLogger();
        const driverLogger = toDriverLogger(logger, 'warn');

        driverLogger.error({}, 'e');
        driverLogger.warn({}, 'w');
        driverLogger.info({}, 'i');
        driverLogger.debug({}, 'd');
        driverLogger.trace({}, 't');

        expect(calls.map(([level]) => level)).toEqual(['error', 'warn']);
    });

    it('keeps the gate across child loggers', () => {
        const { logger, calls } = recordingLogger();

        toDriverLogger(logger, 'silent').child({ scope: 'ws' }).info({}, 'i');

        expect(calls).toEqual([]);
    });

    it('routes every level', () => {
        const { logger, calls } = recordingLogger();
        const driverLogger = toDriverLogger(logger, 'trace');

        driverLogger.trace({}, 't');
        driverLogger.debug({}, 'd');
        driverLogger.info({}, 'i');
        driverLogger.warn({}, 'w');
        driverLogger.error({}, 'e');

        expect(calls.map(([level]) => level)).toEqual(['trace', 'debug', 'info', 'warn', 'error']);
    });
});

describe('buildSocketConfig', () => {
    const keys = { get: () => ({}), set: () => undefined } as unknown as AuthenticationState['keys'];

    it('hands the driver our credentials and the wrapped key store', () => {
        const opts = options();

        const built = buildSocketConfig(opts, browsers, keys);

        expect(built.auth.creds).toBe(opts.auth.creds);
        expect(built.auth.keys).toBe(keys);
    });

    it('applies the QR timeout v1 declared and never read', () => {
        expect(buildSocketConfig(options(), browsers, keys).qrTimeout).toBe(DEFAULT_CONFIG.qr.timeoutMs);
    });

    it('carries the configured driver log level', () => {
        expect(buildSocketConfig(options(), browsers, keys).logger?.level).toBe(DEFAULT_CONFIG.driverLogLevel);
    });

    it('never sets printQRInTerminal, which v7 removed', () => {
        expect(buildSocketConfig(options(), browsers, keys)).not.toHaveProperty('printQRInTerminal');
    });

    it('leaves the browser alone unless pairing is enabled', () => {
        expect(buildSocketConfig(options(), browsers, keys)).not.toHaveProperty('browser');
    });

    it('forces a desktop browser description when pairing is enabled', () => {
        // Pairing by phone code is rejected unless the browser description is a
        // desktop one, and the driver default is not.
        const config = { ...DEFAULT_CONFIG, pairing: { ...DEFAULT_CONFIG.pairing, enabled: true } };

        expect(buildSocketConfig(options(config), browsers, keys).browser).toEqual(['Ubuntu', 'Chrome', '22.04']);
    });

    it('lets an explicit socket option win over our defaults', () => {
        const built = buildSocketConfig(options(DEFAULT_CONFIG, { qrTimeout: 1234 }), browsers, keys);

        expect(built.qrTimeout).toBe(1234);
    });

    it('lets an explicit browser win over the pairing default', () => {
        const config = { ...DEFAULT_CONFIG, pairing: { ...DEFAULT_CONFIG.pairing, enabled: true } };
        const built = buildSocketConfig(options(config, { browser: ['A', 'B', 'C'] }), browsers, keys);

        expect(built.browser).toEqual(['A', 'B', 'C']);
    });

    it('passes unknown driver options straight through', () => {
        const built = buildSocketConfig(options(DEFAULT_CONFIG, { syncFullHistory: true }), browsers, keys);

        expect(built.syncFullHistory).toBe(true);
    });
});

describe('createSocket', () => {
    const stubDriver = () => {
        const socket = { id: 'socket' } as unknown as WASocket;
        const cached = { get: () => ({}), set: () => undefined };
        const makeWASocket = vi.fn((_config: UserFacingSocketConfig) => socket);
        const makeCacheableSignalKeyStore = vi.fn((_store: AuthenticationState['keys']) => cached);
        const driver = {
            makeWASocket,
            makeCacheableSignalKeyStore,
            Browsers: browsers.Browsers,
        } as unknown as BaileysModule;
        return { driver, socket, cached, makeWASocket, makeCacheableSignalKeyStore };
    };

    it('opens a socket through the driver', async () => {
        const stub = stubDriver();
        setDriverLoader(() => Promise.resolve(stub.driver));

        expect(await createSocket(options())).toBe(stub.socket);
    });

    it('puts the driver read-through cache in front of our storage', async () => {
        // Resuming a session asks for the same Signal keys repeatedly; a cache hit is
        // a storage round trip that never happens.
        const stub = stubDriver();
        setDriverLoader(() => Promise.resolve(stub.driver));
        const opts = options();

        await createSocket(opts);

        expect(stub.makeCacheableSignalKeyStore).toHaveBeenCalledTimes(1);
        expect(stub.makeCacheableSignalKeyStore.mock.calls[0]?.[0]).toBe(opts.auth.keys);
        expect(stub.makeWASocket.mock.calls[0]?.[0].auth.keys).toBe(stub.cached);
    });

    it('reports a missing driver as MISSING_PEER', async () => {
        setDriverLoader(() => Promise.reject(new Error('not installed')));

        await expect(createSocket(options())).rejects.toMatchObject({ code: 'MISSING_PEER' });
    });
});
