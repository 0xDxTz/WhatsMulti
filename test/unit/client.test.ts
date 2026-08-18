import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { WhatsMulti, type WhatsMultiOptions } from '../../src/client.js';
import type { WAMessage } from '../../src/compat/baileys.js';
import { definePlugin } from '../../src/plugin.js';
import { memoryLock, sessionLockKey } from '../../src/session/lock.js';
import type { Session } from '../../src/session/session.js';
import { setQrLoader } from '../../src/qr/index.js';
import type { StorageAdapter } from '../../src/storage/adapter.js';
import { memoryStorage } from '../../src/storage/memory.js';
import { fakeDriver, type FakeDriver } from '../fixtures/fake-socket.js';

/**
 * The facade is thin by design, so these are wiring tests: that the config, logger,
 * bus, plugins and manager it builds are actually connected to each other, and that a
 * full session lifecycle runs end to end against a scripted socket.
 */
interface Harness {
    readonly client: WhatsMulti;
    readonly driver: FakeDriver;
    readonly storage: StorageAdapter;
    readonly seen: [string, unknown][];
    of(event: string): unknown[];
}

function harness(options: WhatsMultiOptions = {}, storage: StorageAdapter = memoryStorage()): Harness {
    const driver = fakeDriver();
    const client = new WhatsMulti({ logLevel: 'silent', storage, socketFactory: driver.factory, ...options });

    const seen: [string, unknown][] = [];
    client.process((events) => {
        for (const entry of Object.entries(events)) seen.push(entry);
    });

    return { client, driver, storage, seen, of: (event) => seen.filter(([n]) => n === event).map(([, d]) => d) };
}

/** Registered, started and open: the state most operations require. */
async function opened(h: Harness, sessionId = 'a'): Promise<void> {
    await h.client.createSession(sessionId);
    await h.client.start(sessionId);
    await h.driver.last.open();
}

afterEach(() => {
    setQrLoader(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('construction', () => {
    it('resolves and freezes the config', () => {
        const { client } = harness({ send: { minDelayMs: 25 }, instanceId: 'inst-1' });

        expect(client.instanceId).toBe('inst-1');
        expect(client.config.send.minDelayMs).toBe(25);
        expect(Object.isFrozen(client.config)).toBe(true);
    });

    it('generates an instance id when none is given', () => {
        const { client } = harness();
        expect(client.instanceId).toMatch(/^.+:\d+:[0-9a-f]{6}$/);
    });

    it('rejects an invalid config at construction, not at first use', () => {
        expect(() => new WhatsMulti({ send: { concurrency: 0 } })).toThrow(
            expect.objectContaining({ code: 'INVALID_CONFIG' }) as Error
        );
    });

    it('defaults to file storage, so credentials survive a restart', () => {
        // Constructed, not initialised: nothing touches the disk until a session does.
        expect(new WhatsMulti().storage.name).toBe('file');
    });

    it('accepts a storage shorthand', () => {
        expect(new WhatsMulti({ storage: 'memory' }).storage.name).toBe('memory');
    });

    it('rejects anything that is not a storage backend', () => {
        expect(() => new WhatsMulti({ storage: 'sqlite' as never })).toThrow(
            expect.objectContaining({ code: 'INVALID_CONFIG' }) as Error
        );
    });

    it('exposes the pieces it assembled, for anything it does not delegate', async () => {
        const h = harness();
        const session = await h.client.createSession('a');

        expect(h.client.logger).toBeDefined();
        expect(h.client.events.listenerCount('qr')).toBe(0);
        expect(h.client.sessions.get('a')).toBe(session);
    });

    it('passes socket options through to the driver', async () => {
        const h = harness({ socket: { browser: ['WhatsMulti', 'Chrome', '2.0.0'] } });
        await opened(h);

        expect(h.driver.last.options.socketOptions).toEqual({ browser: ['WhatsMulti', 'Chrome', '2.0.0'] });
    });
});

describe('session registry', () => {
    it('creates, finds and lists sessions', async () => {
        const h = harness();
        const session = await h.client.createSession('a');

        expect(h.client.size).toBe(1);
        expect(h.client.ids()).toEqual(['a']);
        expect(h.client.has('a')).toBe(true);
        expect(h.client.find('a')).toBe(session);
        expect(h.client.session('a')).toBe(session);
    });

    it('reports an unknown session rather than returning undefined', () => {
        const h = harness();

        expect(h.client.find('nope')).toBeUndefined();
        expect(() => h.client.session('nope')).toThrow(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }) as Error);
    });

    it('refuses a duplicate', async () => {
        const h = harness();
        await h.client.createSession('a');

        await expect(h.client.createSession('a')).rejects.toMatchObject({ code: 'SESSION_EXISTS' });
    });

    it('returns the existing session from ensureSession', async () => {
        const h = harness();
        const first = await h.client.createSession('a');

        await expect(h.client.ensureSession('a')).resolves.toBe(first);
    });

    it('records metadata a later process can discover', async () => {
        const h = harness();
        await h.client.createSession('a');

        await expect(h.client.meta('a')).resolves.toMatchObject({ sessionId: 'a', storage: 'memory' });
        await expect(h.client.discover()).resolves.toEqual(['a']);
    });

    it('loads stored sessions that this process has not opened', async () => {
        const storage = memoryStorage();
        const first = harness({}, storage);
        await first.client.createSession('a');
        await first.client.createSession('b');

        const second = harness({}, storage);
        const loaded = await second.client.load();

        expect(loaded.map((s) => s.sessionId)).toEqual(['a', 'b']);
        expect(second.client.ids()).toEqual(['a', 'b']);
    });
});

describe('lifecycle', () => {
    it('runs a session from start to open', async () => {
        const h = harness();
        await h.client.createSession('a');
        await h.client.start('a');

        expect(h.client.session('a').state).toBe('connecting');

        await h.driver.last.qr();
        expect(h.client.session('a').state).toBe('awaiting_scan');

        await h.driver.last.open();
        expect(h.client.session('a').state).toBe('open');
    });

    it('surfaces the QR with the session it belongs to', async () => {
        const h = harness();
        const seen: { sessionId: string; qr: string; attempt: number }[] = [];
        h.client.on('qr', (data, meta) => seen.push({ sessionId: meta.sessionId, ...data }));

        await h.client.createSession('a');
        await h.client.start('a');
        await h.driver.last.qr('qr-1');

        expect(seen).toMatchObject([{ sessionId: 'a', qr: 'qr-1', attempt: 1 }]);
    });

    it('stops and restarts', async () => {
        const h = harness();
        await opened(h);

        await h.client.stop('a');
        expect(h.client.session('a').state).toBe('closed');

        await h.client.restart('a');
        expect(h.client.session('a').state).toBe('connecting');
    });

    it('removes a session locally without unlinking the phone', async () => {
        const h = harness();
        await opened(h);

        await h.client.remove('a');

        expect(h.driver.last.loggedOut).toBe(false);
        expect(h.client.has('a')).toBe(false);
        expect(h.of('session.removed')).toEqual([{ reason: 'deleted' }]);
    });

    it('unlinks the phone on logout', async () => {
        const h = harness();
        await opened(h);

        await h.client.logout('a');

        expect(h.driver.last.loggedOut).toBe(true);
        expect(h.of('session.removed')).toEqual([{ reason: 'logged_out' }]);
    });
});

describe('messaging', () => {
    it('sends through the session queue', async () => {
        const h = harness();
        await opened(h);

        const message = await h.client.send('a', '628123456789', { text: 'hi' });

        expect(h.driver.last.sent).toEqual([['628123456789@s.whatsapp.net', { text: 'hi' }]]);
        expect(message.key.id).toBe('MSG1');
    });

    it('refuses a send on a session that is not open', async () => {
        const h = harness();
        await h.client.createSession('a');

        await expect(h.client.send('a', '628123456789', { text: 'hi' })).rejects.toMatchObject({
            code: 'SESSION_NOT_READY',
        });
    });

    // Delegation only: what a download does, and how it refreshes an expired media
    // URL, is covered against the driver in the messaging suite.
    it('delegates a media download to the session', async () => {
        const h = harness();
        await opened(h);
        const bytes = Buffer.from('media');
        const message = { key: { id: 'M1' } } as WAMessage;
        const download = vi.spyOn(h.client.session('a'), 'downloadMedia').mockResolvedValue(bytes);

        await expect(h.client.downloadMedia('a', message, { startByte: 1 })).resolves.toBe(bytes);
        expect(download).toHaveBeenCalledWith(message, { startByte: 1 });
    });

    it('delegates a streaming media download to the session', async () => {
        const h = harness();
        await opened(h);
        const message = { key: { id: 'M1' } } as WAMessage;
        const stream = Readable.from(['media']);
        const download = vi
            .spyOn(h.client.session('a'), 'downloadMediaStream')
            .mockResolvedValue(stream as unknown as Awaited<ReturnType<Session['downloadMediaStream']>>);

        await expect(h.client.downloadMediaStream('a', message)).resolves.toBe(stream);
        expect(download).toHaveBeenCalledWith(message, undefined);
    });

    it('requests a pairing code once a QR has been issued', async () => {
        const h = harness();
        await h.client.createSession('a');
        await h.client.start('a');
        await h.driver.last.qr();

        await expect(h.client.requestPairingCode('a', '+62 812-3456-789')).resolves.toBe('ABCD-1234');
        expect(h.driver.last.pairingRequests).toEqual(['628123456789']);
    });

    it('refuses a pairing code before the socket has produced a QR', async () => {
        const h = harness();
        await h.client.createSession('a');
        await h.client.start('a');

        await expect(h.client.requestPairingCode('a', '628123456789')).rejects.toMatchObject({
            code: 'PAIRING_UNAVAILABLE',
        });
    });
});

describe('events', () => {
    it('hands driver events to per-event listeners with the session in the meta', async () => {
        const h = harness();
        const upserts: string[] = [];
        h.client.on('messages.upsert', (_data, meta) => upserts.push(meta.sessionId));

        await opened(h);
        await h.driver.last.deliver({ 'messages.upsert': { messages: [], type: 'notify' } });

        expect(upserts).toEqual(['a']);
    });

    it('attaches the open socket to the meta, so a listener can reach the driver', async () => {
        const h = harness();
        const sockets: unknown[] = [];
        h.client.on('messages.upsert', (_data, meta) => sockets.push(meta.socket));

        await opened(h);
        await h.driver.last.deliver({ 'messages.upsert': { messages: [], type: 'notify' } });

        expect(sockets).toEqual([h.driver.last.socket]);
    });

    it('detaches a listener', async () => {
        const h = harness();
        const seen: string[] = [];
        const listener = (): number => seen.push('x');

        h.client.on('session.created', listener);
        expect(h.client.listenerCount('session.created')).toBe(1);

        h.client.off('session.created', listener);
        await h.client.createSession('a');

        expect(seen).toEqual([]);
    });

    it('fires a once listener exactly once', async () => {
        const h = harness();
        const seen: string[] = [];
        h.client.once('session.created', (_d, meta) => seen.push(meta.sessionId));

        await h.client.createSession('a');
        await h.client.createSession('b');

        expect(seen).toEqual(['a']);
    });

    it('unsubscribes a batch listener', async () => {
        const h = harness();
        const batches: unknown[] = [];
        const stop = h.client.process((events) => batches.push(events));

        await h.client.createSession('a');
        stop();
        await h.client.createSession('b');

        expect(batches).toHaveLength(1);
    });
});

describe('plugins', () => {
    it('sets a plugin up on the first operation, once', async () => {
        const setup = vi.fn();
        const h = harness({ plugins: [definePlugin('p', setup)] });

        expect(setup).not.toHaveBeenCalled();

        await h.client.createSession('a');
        await h.client.createSession('b');

        expect(setup).toHaveBeenCalledTimes(1);
    });

    it('gives a plugin the bus and a scoped logger', async () => {
        const seen: string[] = [];
        const plugin = definePlugin('watcher', (ctx) =>
            ctx.events.on('session.created', (_d, m) => seen.push(m.sessionId))
        );
        const h = harness({ plugins: [plugin] });

        await h.client.createSession('a');

        expect(seen).toEqual(['a']);
    });

    it('registers a plugin through use(), chainably', async () => {
        const setup = vi.fn();
        const h = harness();

        expect(h.client.use(definePlugin('p', setup))).toBe(h.client);
        await h.client.init();

        expect(setup).toHaveBeenCalledTimes(1);
    });

    it('refuses a plugin registered after setup, which would have missed events', async () => {
        const h = harness();
        await h.client.init();

        expect(() => h.client.use(definePlugin('late', () => {}))).toThrow(
            expect.objectContaining({ code: 'INVALID_CONFIG' }) as Error
        );
    });

    it('disposes plugins after the sessions have stopped, so a forwarder can flush', async () => {
        const order: string[] = [];
        const plugin = definePlugin(
            'p',
            () => {},
            () => order.push('dispose')
        );
        const h = harness({ plugins: [plugin] });

        await opened(h);
        h.client.on('session.state', (data) => {
            if (data.to === 'closed') order.push('stopped');
        });

        await h.client.destroy();

        expect(order).toEqual(['stopped', 'dispose']);
    });
});

describe('qr printing', () => {
    it('prints every QR to stdout when qr.print is on', async () => {
        const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        setQrLoader(() =>
            Promise.resolve({ toString: () => Promise.resolve('ART'), toDataURL: () => {}, toBuffer: () => {} })
        );

        const h = harness({ qr: { print: true } });
        await h.client.createSession('a');
        await h.client.start('a');
        await h.driver.last.qr();
        await vi.waitFor(() => expect(write).toHaveBeenCalled());

        expect(write).toHaveBeenCalledWith('\nART\n');
    });

    it('does not print when qr.print is off', async () => {
        const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        const h = harness();

        await h.client.createSession('a');
        await h.client.start('a');
        await h.driver.last.qr();

        expect(write).not.toHaveBeenCalled();
    });

    it('survives a missing renderer: the session keeps pairing', async () => {
        setQrLoader(() => Promise.reject(new Error('Cannot find module')));
        const h = harness({ qr: { print: true } });

        await h.client.createSession('a');
        await h.client.start('a');
        await h.driver.last.qr();
        await h.driver.last.open();

        expect(h.client.session('a').state).toBe('open');
        expect(h.of('session.error')).toEqual([]);
    });
});

/**
 * The gate for phase 7. Two clients, one lock provider, one storage backend -- the
 * shape a cluster has, minus the network. Fencing is the one failure mode where
 * getting it wrong corrupts data rather than dropping a message: two processes on one
 * session write the same Signal key store, and neither session survives it.
 */
describe('two clients contending for one session', () => {
    function pair(): { a: Harness; b: Harness } {
        const lockProvider = memoryLock();
        const storage = memoryStorage();

        return {
            a: harness({ instanceId: 'inst-a', lockProvider }, storage),
            b: harness({ instanceId: 'inst-b', lockProvider }, storage),
        };
    }

    it('lets only one of them start the session', async () => {
        const { a, b } = pair();
        await a.client.createSession('a');
        await b.client.createSession('a');

        await a.client.start('a');

        await expect(b.client.start('a')).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
    });

    it('tells the loser which instance holds it', async () => {
        const { a, b } = pair();
        await a.client.createSession('a');
        await b.client.createSession('a');
        await a.client.start('a');

        const error = await b.client.start('a').catch((cause: unknown) => cause);

        expect((error as Error).message).toContain('inst-a');
    });

    it('opens no socket for the loser', async () => {
        const { a, b } = pair();
        await a.client.createSession('a');
        await b.client.createSession('a');
        await a.client.start('a');

        await b.client.start('a').catch(() => undefined);

        expect(b.driver.sockets).toHaveLength(0);
    });

    it('hands the session over once the holder stops', async () => {
        const { a, b } = pair();
        await a.client.createSession('a');
        await b.client.createSession('a');
        await a.client.start('a');

        await a.client.stop('a');

        await expect(b.client.start('a')).resolves.toBeUndefined();
        expect(a.client.lockProvider).toBe(b.client.lockProvider);
    });

    it('hands it over on destroy too, so a rolling deploy does not deadlock', async () => {
        const { a, b } = pair();
        await a.client.createSession('a');
        await b.client.createSession('a');
        await a.client.start('a');

        await a.client.destroy();

        await expect(b.client.start('a')).resolves.toBeUndefined();
    });

    it('does not let one client block a session another one owns', async () => {
        const { a, b } = pair();
        await a.client.createSession('a');
        await b.client.createSession('b');

        await a.client.start('a');

        await expect(b.client.start('b')).resolves.toBeUndefined();
    });

    it('gives each client its own lock by default, which is why sharing is explicit', async () => {
        const storage = memoryStorage();
        const a = harness({ instanceId: 'inst-a' }, storage);
        const b = harness({ instanceId: 'inst-b' }, storage);
        await a.client.createSession('a');
        await b.client.createSession('a');

        await a.client.start('a');

        // Not a bug: an in-memory lock cannot fence across processes either, so a
        // default that pretended to would be worse than one that plainly does not.
        await expect(b.client.start('a')).resolves.toBeUndefined();
        expect(a.client.lockProvider).not.toBe(b.client.lockProvider);
    });

    it('fences the holder when the lock is taken from underneath it', async () => {
        // Fake timers from the outset: the heartbeat is scheduled during start(), and
        // a clock swapped in afterwards would never fire it.
        vi.useFakeTimers();

        const { a, b } = pair();
        await a.client.createSession('a');
        await b.client.createSession('a');
        await a.client.start('a');
        await a.driver.last.open();

        const fenced: string[] = [];
        a.client.on('session.fenced', (data, meta) => fenced.push(`${meta.sessionId}:${data.owner}`));

        // What a stalled instance looks like from outside: its lease is gone and the
        // peer has taken over. The holder finds out on its next heartbeat.
        await a.client.lockProvider.release(a.client.session('a').lock!);
        await b.client.lockProvider.acquire(sessionLockKey('a'), 30_000, 'inst-b');

        await vi.advanceTimersByTimeAsync(30_000);

        expect(fenced).toEqual(['a:inst-b']);
        expect(a.client.session('a').state).toBe('closed');
        expect(a.driver.last.ended).toBe(true);
    });
});

describe('destroy', () => {
    it('stops every session and closes the adapter', async () => {
        // close() is optional on the contract and the memory adapter does not need
        // one, so it is added here to prove the client calls it when it exists.
        const close = vi.fn(() => Promise.resolve());
        const storage: StorageAdapter = { ...memoryStorage(), close };
        const h = harness({}, storage);
        await opened(h);

        await h.client.destroy();

        expect(h.driver.last.ended).toBe(true);
        expect(close).toHaveBeenCalledTimes(1);
        expect(h.client.destroyed).toBe(true);
    });

    it('is idempotent, so a signal handler can call it twice', async () => {
        const h = harness();
        await h.client.destroy();
        await expect(h.client.destroy()).resolves.toBeUndefined();
    });

    it('refuses every operation afterwards, naming the client rather than the session', async () => {
        const h = harness();
        await opened(h);
        await h.client.destroy();

        const destroyed = { code: 'CLIENT_DESTROYED' };
        await expect(h.client.createSession('b')).rejects.toMatchObject(destroyed);
        await expect(h.client.start('a')).rejects.toMatchObject(destroyed);
        await expect(h.client.stop('a')).rejects.toMatchObject(destroyed);
        await expect(h.client.send('a', '628123456789', { text: 'hi' })).rejects.toMatchObject(destroyed);
        await expect(h.client.logout('a')).rejects.toMatchObject(destroyed);
        await expect(h.client.remove('a')).rejects.toMatchObject(destroyed);
        await expect(h.client.meta('a')).rejects.toMatchObject(destroyed);
        await expect(h.client.load()).rejects.toMatchObject(destroyed);
        await expect(h.client.requestPairingCode('a', '628123456789')).rejects.toMatchObject(destroyed);
        expect(() => h.client.use(definePlugin('p', () => {}))).toThrow(expect.objectContaining(destroyed) as Error);
    });
});
