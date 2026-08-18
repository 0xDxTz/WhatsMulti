import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, type ResolvedConfig } from '../../src/config.js';
import { WMEventEmitter } from '../../src/events/emitter.js';
import type { EventMeta } from '../../src/events/types.js';
import { silentLogger } from '../../src/logger.js';
import { Session, formatPairingCode } from '../../src/session/session.js';
import { memoryStorage } from '../../src/storage/memory.js';
import type { StorageAdapter } from '../../src/storage/adapter.js';
import { sessionPrefix } from '../../src/storage/namespace.js';
import { mulberry32 } from '../../src/utils/random.js';
import { fakeDriver, failingDriver } from '../fixtures/fake-socket.js';

const config = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
    ...DEFAULT_CONFIG,
    instanceId: 'test-instance',
    ...overrides,
});

interface Harness {
    readonly session: Session;
    readonly driver: ReturnType<typeof fakeDriver>;
    readonly storage: StorageAdapter;
    readonly emitter: WMEventEmitter;
    readonly seen: [string, unknown, EventMeta][];
    readonly of: (event: string) => unknown[];
}

function harness(overrides: Partial<ResolvedConfig> = {}, storage: StorageAdapter = memoryStorage()): Harness {
    const driver = fakeDriver();
    const emitter = new WMEventEmitter();
    const seen: [string, unknown, EventMeta][] = [];
    emitter.process((events, meta) => {
        for (const [name, data] of Object.entries(events)) seen.push([name, data, meta]);
    });

    const session = new Session({
        sessionId: 's1',
        storage,
        config: config(overrides),
        emitter,
        logger: silentLogger,
        socketFactory: driver.factory,
        random: mulberry32(1),
    });

    return {
        session,
        driver,
        storage,
        emitter,
        seen,
        of: (event) => seen.filter(([n]) => n === event).map(([, d]) => d),
    };
}

/** Drives the session to `open`, the way a paired session starts. */
async function opened(overrides: Partial<ResolvedConfig> = {}): Promise<Harness> {
    const h = harness(overrides);
    await h.session.start();
    await h.driver.last.open();
    return h;
}

describe('formatPairingCode', () => {
    it('splits the eight-character code the driver returns', () => {
        expect(formatPairingCode('ABCD1234')).toBe('ABCD-1234');
    });

    it('leaves an already-formatted or unexpected code alone', () => {
        expect(formatPairingCode('ABCD-1234')).toBe('ABCD-1234');
        expect(formatPairingCode('SHORT')).toBe('SHORT');
    });
});

describe('Session.start', () => {
    it('moves to connecting and opens a socket', async () => {
        const h = harness();

        await h.session.start();

        expect(h.session.state).toBe('connecting');
        expect(h.driver.sockets).toHaveLength(1);
        expect(h.session.socket).toBe(h.driver.last.socket);
    });

    it('resolves before the connection is open', async () => {
        // An unpaired session sits in awaiting_scan until someone scans, which could
        // be never. Waiting for `open` here would hang.
        const h = harness();

        await expect(h.session.start()).resolves.toBeUndefined();
        expect(h.session.state).not.toBe('open');
    });

    it('refuses a second start instead of opening two sockets', async () => {
        const h = harness();
        await h.session.start();

        await expect(h.session.start()).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
        expect(h.driver.sockets).toHaveLength(1);
    });

    it('returns to closed when the socket cannot be opened', async () => {
        const h = harness();
        const session = new Session({
            sessionId: 's1',
            storage: h.storage,
            config: config(),
            emitter: h.emitter,
            logger: silentLogger,
            socketFactory: failingDriver(new Error('no network')),
        });

        await expect(session.start()).rejects.toThrow('no network');
        expect(session.state).toBe('closed');
    });

    it('can be started again after it closed', async () => {
        const h = await opened();
        await h.session.stop();

        await h.session.start();

        expect(h.session.state).toBe('connecting');
        expect(h.driver.sockets).toHaveLength(2);
    });

    it('emits session.state for every transition', async () => {
        const h = harness();

        await h.session.start();
        await h.driver.last.open();

        expect(h.of('session.state')).toEqual([
            { from: 'idle', to: 'connecting', reason: 'start' },
            { from: 'connecting', to: 'open', reason: 'connected' },
        ]);
    });

    it('stamps every event with the session and instance', async () => {
        const h = await opened();

        const [, , meta] = h.seen[0] as [string, unknown, EventMeta];
        expect(meta.sessionId).toBe('s1');
        expect(meta.instanceId).toBe('test-instance');
    });
});

describe('Session QR handling', () => {
    it('emits the raw QR and moves to awaiting_scan', async () => {
        const h = harness();
        await h.session.start();

        await h.driver.last.qr('code-1');

        expect(h.session.state).toBe('awaiting_scan');
        expect(h.of('qr')).toEqual([{ qr: 'code-1', attempt: 1, expiresAt: expect.any(Number) as unknown as number }]);
    });

    it('counts attempts across refreshes', async () => {
        const h = harness();
        await h.session.start();

        await h.driver.last.qr();
        await h.driver.last.qr();

        expect(h.session.qrAttempt).toBe(2);
        expect(h.of('qr')).toHaveLength(2);
    });

    it('gives up after the configured number of attempts', async () => {
        // v1 declared maxQrAttempts in its types and never read it.
        const h = harness({ qr: { ...DEFAULT_CONFIG.qr, maxAttempts: 2 } });
        await h.session.start();

        await h.driver.last.qr();
        await h.driver.last.qr();
        await h.driver.last.qr();

        expect(h.of('qr')).toHaveLength(2);
        expect(h.session.state).toBe('closed');
        expect(h.driver.sockets[0]?.ended).toBe(true);
    });

    it('does not reconnect after exhausting QR attempts', async () => {
        const h = harness({ qr: { ...DEFAULT_CONFIG.qr, maxAttempts: 1 } });
        await h.session.start();
        await h.driver.last.qr();
        await h.driver.last.qr();

        expect(h.of('session.reconnecting')).toEqual([]);
        expect(h.driver.sockets).toHaveLength(1);
    });

    it('suppresses the QR when pairing by code', async () => {
        // Showing a QR for a session being paired by phone code is noise, and
        // scanning it would race the code.
        const h = harness({ pairing: { ...DEFAULT_CONFIG.pairing, enabled: true } });
        await h.session.start();

        await h.driver.last.qr();

        expect(h.of('qr')).toEqual([]);
        expect(h.session.state).toBe('awaiting_scan');
    });

    it('resets the counter once the connection opens', async () => {
        const h = harness();
        await h.session.start();
        await h.driver.last.qr();

        await h.driver.last.open();

        expect(h.session.qrAttempt).toBe(0);
    });
});

describe('Session credentials', () => {
    it('saves credentials when the driver updates them', async () => {
        const storage = memoryStorage();
        const h = harness({}, storage);
        await h.session.start();

        await h.driver.last.credsUpdate();

        expect(await storage.keys(sessionPrefix('s1'))).toContain('whatsmulti:s1:creds');
    });

    it('reuses the stored credentials on the next start', async () => {
        const storage = memoryStorage();
        const first = harness({}, storage);
        await first.session.start();
        await first.driver.last.credsUpdate();
        const before = (await storage.get('whatsmulti:s1:creds')) as { registrationId: number };

        const second = harness({}, storage);
        await second.session.start();
        await second.driver.last.credsUpdate();

        expect(await storage.get('whatsmulti:s1:creds')).toMatchObject({ registrationId: before.registrationId });
    });
});

describe('Session disconnects', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reconnects after a recoverable close, with a backoff delay', async () => {
        const h = await opened();

        await h.driver.last.close(428);

        expect(h.session.state).toBe('closed');
        const [reconnecting] = h.of('session.reconnecting') as [{ attempt: number; delayMs: number; cause: string }];
        expect(reconnecting).toMatchObject({ attempt: 1, cause: 'connection_closed' });
        expect(reconnecting.delayMs).toBeGreaterThanOrEqual(DEFAULT_CONFIG.reconnect.floorMs);

        await vi.advanceTimersByTimeAsync(reconnecting.delayMs);

        expect(h.session.state).toBe('connecting');
        expect(h.driver.sockets).toHaveLength(2);
    });

    it('reconnects immediately after a stream restart, consuming no attempt', async () => {
        const h = harness();
        await h.session.start();
        await h.driver.last.qr();

        await h.driver.last.close(515);

        expect(h.of('session.reconnecting')).toEqual([{ attempt: 0, delayMs: 0, cause: 'restart_required' }]);
        expect(h.session.state).toBe('connecting');

        await vi.advanceTimersByTimeAsync(0);

        expect(h.driver.sockets).toHaveLength(2);
        expect(h.session.reconnectAttempt).toBe(0);
    });

    it('grows the delay across consecutive failures', async () => {
        const h = await opened();
        const delays: number[] = [];

        for (let i = 0; i < 4; i++) {
            await h.driver.last.close(408);
            const plan = h.of('session.reconnecting').at(-1) as { delayMs: number };
            delays.push(plan.delayMs);
            await vi.advanceTimersByTimeAsync(plan.delayMs);
        }

        expect(delays.at(-1)).toBeGreaterThan(delays[0] as number);
        expect(h.session.reconnectAttempt).toBe(4);
    });

    it('resets the attempt counter once it reconnects', async () => {
        const h = await opened();
        await h.driver.last.close(428);
        await vi.advanceTimersByTimeAsync(60_000);

        await h.driver.last.open();

        expect(h.session.reconnectAttempt).toBe(0);
    });

    it('stops trying once the attempt cap is exhausted', async () => {
        const h = await opened({ reconnect: { ...DEFAULT_CONFIG.reconnect, maxAttempts: 1 } });

        await h.driver.last.close(428);
        await vi.advanceTimersByTimeAsync(60_000);
        await h.driver.last.close(428);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(h.of('session.reconnecting')).toHaveLength(1);
        expect(h.session.state).toBe('closed');
        expect(h.driver.sockets).toHaveLength(2);
    });

    it('never reconnects when reconnect is disabled', async () => {
        const h = await opened({ reconnect: { ...DEFAULT_CONFIG.reconnect, enabled: false } });

        await h.driver.last.close(428);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(h.of('session.reconnecting')).toEqual([]);
        expect(h.driver.sockets).toHaveLength(1);
    });

    it.each([
        [440, 'connection_replaced'],
        [403, 'device_removed'],
        [411, 'multidevice_mismatch'],
    ] as const)('does not reconnect after a terminal %i (%s)', async (status, _cause) => {
        const h = await opened();

        await h.driver.last.close(status);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(h.of('session.reconnecting')).toEqual([]);
        expect(h.driver.sockets).toHaveLength(1);
    });

    it('purges credentials and reports a logout on 401', async () => {
        const storage = memoryStorage();
        const h = harness({}, storage);
        await h.session.start();
        await h.driver.last.open();
        await h.driver.last.credsUpdate();

        await h.driver.last.close(401);

        expect(h.session.state).toBe('logged_out');
        expect(h.of('session.logged_out')).toEqual([{ cause: 'logged_out' }]);
        expect(await storage.keys(sessionPrefix('s1'))).toEqual([]);
    });

    it('keeps credentials on a transient 500', async () => {
        // Baileys uses 500 for both badSession and an ordinary server error; purging
        // on the latter deletes a working session.
        const storage = memoryStorage();
        const h = harness({}, storage);
        await h.session.start();
        await h.driver.last.open();
        await h.driver.last.credsUpdate();

        await h.driver.last.close(500);

        expect(h.of('session.logged_out')).toEqual([]);
        expect(await storage.keys(sessionPrefix('s1'))).not.toEqual([]);
    });

    it('purges when the payload actually says the session is bad', async () => {
        const storage = memoryStorage();
        const h = harness({}, storage);
        await h.session.start();
        await h.driver.last.open();
        await h.driver.last.credsUpdate();

        await h.driver.last.close(500, 'Bad Session detected');

        expect(h.of('session.logged_out')).toEqual([{ cause: 'bad_session' }]);
        expect(await storage.keys(sessionPrefix('s1'))).toEqual([]);
    });

    it('treats an unrecognised close as recoverable', async () => {
        const h = await opened();

        await h.driver.last.close();

        expect(h.of('session.reconnecting')).toEqual([
            expect.objectContaining({ cause: 'unknown' }) as unknown as object,
        ]);
    });

    it('drops the dead socket rather than holding a reference to it', async () => {
        const h = await opened();

        await h.driver.last.close(428);

        expect(h.session.socket).toBeUndefined();
        expect(h.driver.sockets[0]?.attached).toBe(false);
    });
});

describe('Session socket options', () => {
    it('hands the consumer options straight to the factory', async () => {
        const driver = fakeDriver();
        const session = new Session({
            sessionId: 's1',
            storage: memoryStorage(),
            config: config(),
            emitter: new WMEventEmitter(),
            logger: silentLogger,
            socketFactory: driver.factory,
            socketOptions: { syncFullHistory: true },
        });

        await session.start();

        expect(driver.last.options.socketOptions).toEqual({ syncFullHistory: true });
    });

    it('omits the key entirely when none were given', async () => {
        const h = harness();

        await h.session.start();

        expect(h.driver.last.options.socketOptions).toBeUndefined();
    });
});

describe('Session.sendable', () => {
    it('is true only while the connection is open', async () => {
        const h = harness();
        expect(h.session.sendable).toBe(false);

        await h.session.start();
        await h.driver.last.qr();
        expect(h.session.sendable).toBe(false);

        await h.driver.last.open();
        expect(h.session.sendable).toBe(true);

        await h.session.stop();
        expect(h.session.sendable).toBe(false);
    });
});

describe('Session reconnect failures', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reports a failed reconnect and settles closed instead of hanging in connecting', async () => {
        const driver = fakeDriver();
        const emitter = new WMEventEmitter();
        const seen: string[] = [];
        emitter.process((events) => seen.push(...Object.keys(events)));
        let attempts = 0;
        const session = new Session({
            sessionId: 's1',
            storage: memoryStorage(),
            config: config(),
            emitter,
            logger: silentLogger,
            random: mulberry32(1),
            socketFactory: (options) => {
                attempts += 1;
                return attempts === 1 ? driver.factory(options) : Promise.reject(new Error('still down'));
            },
        });
        await session.start();
        await driver.last.open();

        await driver.last.close(428);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(session.state).toBe('closed');
        expect(seen).toContain('session.error');
    });
});

describe('Session.stop', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('closes the socket and settles in closed', async () => {
        const h = await opened();

        await h.session.stop();

        expect(h.session.state).toBe('closed');
        expect(h.driver.last.ended).toBe(true);
        expect(h.session.socket).toBeUndefined();
    });

    it('cancels a pending reconnect', async () => {
        const h = await opened();
        await h.driver.last.close(428);

        await h.session.stop();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(h.driver.sockets).toHaveLength(1);
    });

    it('is safe to call on a session that never started', async () => {
        const h = harness();

        await expect(h.session.stop()).resolves.toBeUndefined();
        expect(h.session.state).toBe('idle');
    });

    it('is safe to call twice', async () => {
        const h = await opened();
        await h.session.stop();

        await expect(h.session.stop()).resolves.toBeUndefined();
    });

    it('survives a socket that throws while closing', async () => {
        const h = await opened();
        h.driver.last.endError = new Error('already gone');

        await expect(h.session.stop()).resolves.toBeUndefined();
        expect(h.session.state).toBe('closed');
    });
});

describe('Session.logout', () => {
    it('unlinks the device, then deletes the local state', async () => {
        const storage = memoryStorage();
        const h = harness({}, storage);
        await h.session.start();
        await h.driver.last.open();
        await h.driver.last.credsUpdate();

        await h.session.logout();

        expect(h.driver.last.loggedOut).toBe(true);
        expect(h.session.state).toBe('logged_out');
        expect(await storage.keys(sessionPrefix('s1'))).toEqual([]);
        expect(h.of('session.logged_out')).toEqual([{ cause: 'logged_out' }]);
    });

    it('refuses when the session is not open', async () => {
        const h = harness();

        await expect(h.session.logout()).rejects.toMatchObject({ code: 'SESSION_NOT_READY' });
    });

    it('keeps credentials when the unlink fails', async () => {
        // Purging them would leave a device linked to the phone that can never be
        // unlinked again, because the credentials needed to try are gone.
        const storage = memoryStorage();
        const h = harness({}, storage);
        await h.session.start();
        await h.driver.last.open();
        await h.driver.last.credsUpdate();
        h.driver.last.logoutError = new Error('socket closed');

        await expect(h.session.logout()).rejects.toMatchObject({ code: 'LOGOUT_FAILED' });

        expect(await storage.keys(sessionPrefix('s1'))).not.toEqual([]);
        expect(h.session.state).toBe('open');
    });

    it('reports the underlying reason', async () => {
        const h = await opened();
        h.driver.last.logoutError = new Error('socket closed');

        await expect(h.session.logout()).rejects.toThrow(/socket closed/);
    });

    it('emits the logout exactly once', async () => {
        const h = await opened();

        await h.session.logout();

        expect(h.of('session.logged_out')).toHaveLength(1);
    });
});

describe('Session.remove', () => {
    it('deletes local data without unlinking the device', async () => {
        // v1 conflated the two: deleteSession called logout(), so asking for local
        // cleanup silently unlinked the device.
        const storage = memoryStorage();
        const h = harness({}, storage);
        await h.session.start();
        await h.driver.last.open();
        await h.driver.last.credsUpdate();

        await h.session.remove();

        expect(h.driver.last.loggedOut).toBe(false);
        expect(await storage.keys(sessionPrefix('s1'))).toEqual([]);
        expect(h.session.state).toBe('closed');
    });
});

describe('Session.reset', () => {
    it('lets a logged-out session be paired again', async () => {
        const h = await opened();
        await h.driver.last.close(401);

        h.session.reset();

        expect(h.session.state).toBe('idle');
        await expect(h.session.start()).resolves.toBeUndefined();
    });

    it('refuses from any other state', async () => {
        const h = await opened();

        expect(() => h.session.reset()).toThrow(expect.objectContaining({ code: 'ILLEGAL_TRANSITION' }) as Error);
    });
});

describe('Session.requestPairingCode', () => {
    const pairing = { pairing: { ...DEFAULT_CONFIG.pairing, enabled: true } };

    const awaitingScan = async () => {
        const h = harness(pairing);
        await h.session.start();
        await h.driver.last.qr();
        return h;
    };

    it('returns a formatted code and reports it', async () => {
        const h = await awaitingScan();

        const code = await h.session.requestPairingCode('+62 812-3456-789');

        expect(code).toBe('ABCD-1234');
        expect(h.driver.last.pairingRequests).toEqual(['628123456789']);
        expect(h.of('pairing.code')).toEqual([
            { code: 'ABCD-1234', phoneNumber: '628123456789', expiresAt: expect.any(Number) as unknown as number },
        ]);
    });

    it('refuses before the first QR has been seen', async () => {
        // The code is bound to a QR reference, so there is nothing to bind to yet.
        const h = harness(pairing);
        await h.session.start();

        await expect(h.session.requestPairingCode('628123456789')).rejects.toMatchObject({
            code: 'PAIRING_UNAVAILABLE',
        });
    });

    it('refuses once the session is open', async () => {
        const h = await opened(pairing);

        await expect(h.session.requestPairingCode('628123456789')).rejects.toMatchObject({
            code: 'PAIRING_UNAVAILABLE',
        });
    });

    it('rejects a phone number the Go build would reject', async () => {
        const h = await awaitingScan();

        await expect(h.session.requestPairingCode('0812345678')).rejects.toMatchObject({
            code: 'INVALID_PHONE_NUMBER',
        });
        await expect(h.session.requestPairingCode('12345')).rejects.toMatchObject({
            code: 'INVALID_PHONE_NUMBER',
        });
    });

    it('refuses a second pending request', async () => {
        // A second request silently invalidates the first, so the user would be shown
        // a code that can never work.
        const h = await awaitingScan();
        await h.session.requestPairingCode('628123456789');

        await expect(h.session.requestPairingCode('628123456789')).rejects.toMatchObject({
            code: 'PAIRING_IN_PROGRESS',
        });
    });

    it('allows a new request once the QR refreshes', async () => {
        const h = await awaitingScan();
        await h.session.requestPairingCode('628123456789');

        await h.driver.last.qr();

        await expect(h.session.requestPairingCode('628123456789')).resolves.toBe('ABCD-1234');
    });

    it('clears the pending flag when the driver rejects', async () => {
        const h = await awaitingScan();
        h.driver.last.pairingError = new Error('rate limited');

        await expect(h.session.requestPairingCode('628123456789')).rejects.toMatchObject({
            code: 'PAIRING_UNAVAILABLE',
        });

        h.driver.last.pairingError = undefined;
        await expect(h.session.requestPairingCode('628123456789')).resolves.toBe('ABCD-1234');
    });
});

describe('Session.destroy', () => {
    it('stops the socket and refuses further use', async () => {
        const h = await opened();

        await h.session.destroy();

        expect(h.session.destroyed).toBe(true);
        expect(h.driver.last.ended).toBe(true);
        await expect(h.session.start()).rejects.toMatchObject({ code: 'CLIENT_DESTROYED' });
        await expect(h.session.logout()).rejects.toMatchObject({ code: 'CLIENT_DESTROYED' });
        await expect(h.session.requestPairingCode('628123456789')).rejects.toMatchObject({
            code: 'CLIENT_DESTROYED',
        });
        expect(() => h.session.reset()).toThrow(expect.objectContaining({ code: 'CLIENT_DESTROYED' }) as Error);
    });

    it('is idempotent', async () => {
        const h = await opened();
        await h.session.destroy();

        await expect(h.session.destroy()).resolves.toBeUndefined();
    });

    it('cancels a pending reconnect', async () => {
        vi.useFakeTimers();
        try {
            const h = await opened();
            await h.driver.last.close(428);

            await h.session.destroy();
            await vi.advanceTimersByTimeAsync(60_000);

            expect(h.driver.sockets).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('Session event forwarding', () => {
    it('hands the driver batch through intact', async () => {
        // v1 re-split ev.process's buffered map into one call per event, discarding
        // the batching the driver works to provide.
        const h = await opened();
        const batches: Record<string, unknown>[] = [];
        h.emitter.process((events) => batches.push(events));

        await h.driver.last.deliver({
            'messages.upsert': { messages: [], type: 'notify' },
            'chats.update': [],
        });

        expect(batches).toEqual([{ 'messages.upsert': { messages: [], type: 'notify' }, 'chats.update': [] }]);
    });

    it('reports a failure while handling a batch as session.error', async () => {
        const h = await opened();
        const broken: StorageAdapter = { ...h.storage, set: () => Promise.reject(new Error('disk full')) };
        const session = new Session({
            sessionId: 's2',
            storage: broken,
            config: config(),
            emitter: h.emitter,
            logger: silentLogger,
            socketFactory: h.driver.factory,
        });
        await session.start();

        await h.driver.last.credsUpdate();

        expect(h.of('session.error')).toEqual([
            expect.objectContaining({ code: 'STORAGE_ERROR' }) as unknown as object,
        ]);
    });

    it('still forwards the batch after an internal failure', async () => {
        const h = await opened();
        const broken: StorageAdapter = { ...h.storage, set: () => Promise.reject(new Error('disk full')) };
        const session = new Session({
            sessionId: 's2',
            storage: broken,
            config: config(),
            emitter: h.emitter,
            logger: silentLogger,
            socketFactory: h.driver.factory,
        });
        await session.start();

        await h.driver.last.credsUpdate();

        // The consumer's own handler must still see creds.update even though our
        // internal save threw: swallowing the batch would hide driver events behind
        // an unrelated storage fault.
        expect(h.seen.filter(([name]) => name === 'creds.update')).toHaveLength(1);
    });
});
