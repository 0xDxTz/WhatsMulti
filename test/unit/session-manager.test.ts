import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, type ResolvedConfig } from '../../src/config.js';
import { WMEventEmitter } from '../../src/events/emitter.js';
import { silentLogger } from '../../src/logger.js';
import { SessionManager } from '../../src/session/manager.js';
import type { StorageAdapter } from '../../src/storage/adapter.js';
import { memoryStorage } from '../../src/storage/memory.js';
import { sessionPrefix } from '../../src/storage/namespace.js';
import { fakeDriver } from '../fixtures/fake-socket.js';

const config = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
    ...DEFAULT_CONFIG,
    instanceId: 'test-instance',
    ...overrides,
});

function harness(overrides: Partial<ResolvedConfig> = {}, storage: StorageAdapter = memoryStorage()) {
    const driver = fakeDriver();
    const emitter = new WMEventEmitter();
    const seen: [string, unknown][] = [];
    emitter.process((events) => {
        for (const entry of Object.entries(events)) seen.push(entry);
    });

    const manager = new SessionManager({
        config: config(overrides),
        storage,
        emitter,
        logger: silentLogger,
        socketFactory: driver.factory,
    });

    return { manager, driver, storage, emitter, seen, of: (event: string) => seen.filter(([n]) => n === event) };
}

describe('SessionManager.create', () => {
    it('registers a session and reports it', async () => {
        const h = harness();

        const session = await h.manager.create('a');

        expect(h.manager.size).toBe(1);
        expect(h.manager.ids()).toEqual(['a']);
        expect(h.manager.get('a')).toBe(session);
        expect(h.of('session.created')).toEqual([['session.created', { storage: 'memory' }]]);
    });

    it('exposes the live sessions as objects', async () => {
        const h = harness();
        const a = await h.manager.create('a');

        expect(h.manager.all()).toEqual([a]);
    });

    it('records metadata so the session is discoverable before it pairs', async () => {
        const h = harness();

        await h.manager.create('a');

        expect(await h.manager.meta('a')).toMatchObject({ sessionId: 'a', storage: 'memory' });
        expect(await h.manager.discover()).toEqual(['a']);
    });

    it('rejects a duplicate id instead of replacing the live session', async () => {
        const h = harness();
        await h.manager.create('a');

        await expect(h.manager.create('a')).rejects.toMatchObject({ code: 'SESSION_EXISTS' });
        expect(h.manager.size).toBe(1);
    });

    it('rejects an invalid id', async () => {
        const h = harness();

        await expect(h.manager.create('bad id')).rejects.toMatchObject({ code: 'INVALID_SESSION_ID' });
    });

    it('keeps the original creation time when a stored session is re-registered', async () => {
        const storage = memoryStorage();
        const first = harness({}, storage);
        await first.manager.create('a');
        const before = await first.manager.meta('a');

        const second = harness({}, storage);
        await second.manager.create('a');

        expect((await second.manager.meta('a'))?.createdAt).toBe(before?.createdAt);
    });

    it('starts the session when asked to', async () => {
        const h = harness();

        const session = await h.manager.create('a', { autoStart: true });

        expect(session.state).toBe('connecting');
    });

    it('accepts a per-session storage override', async () => {
        const override = memoryStorage();
        const h = harness();

        await h.manager.create('a', { storage: override });

        expect(await override.keys(sessionPrefix('a'))).not.toEqual([]);
        expect(await h.storage.keys(sessionPrefix('a'))).toEqual([]);
    });

    it('initialises the adapter before writing to it', async () => {
        const inner = memoryStorage();
        const init = vi.fn(() => Promise.resolve());
        const h = harness({}, { ...inner, init });

        await h.manager.create('a');

        expect(init).toHaveBeenCalled();
    });
});

describe('SessionManager.ensure', () => {
    it('creates once and returns the same session after that', async () => {
        const h = harness();

        const first = await h.manager.ensure('a');
        const second = await h.manager.ensure('a');

        expect(second).toBe(first);
        expect(h.of('session.created')).toHaveLength(1);
    });
});

describe('SessionManager.get', () => {
    it('reports a missing session by code, not by returning undefined', async () => {
        const h = harness();

        expect(() => h.manager.get('nope')).toThrow(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }) as Error);
        expect(h.manager.find('nope')).toBeUndefined();
        expect(h.manager.has('nope')).toBe(false);
        await expect(h.manager.start('nope')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    });
});

describe('SessionManager lifecycle delegation', () => {
    it('starts and stops through the manager', async () => {
        const h = harness();
        await h.manager.create('a');

        await h.manager.start('a');
        expect(h.manager.get('a').state).toBe('connecting');

        await h.manager.stop('a');
        expect(h.manager.get('a').state).toBe('closed');
    });

    it('restarts on a fresh socket', async () => {
        const h = harness();
        await h.manager.create('a', { autoStart: true });

        await h.manager.restart('a');

        expect(h.driver.sockets).toHaveLength(2);
        expect(h.manager.get('a').state).toBe('connecting');
    });
});

describe('SessionManager.remove', () => {
    it('deletes local data and deregisters, leaving the device linked', async () => {
        const h = harness();
        await h.manager.create('a', { autoStart: true });
        await h.driver.last.open();

        await h.manager.remove('a');

        expect(h.driver.last.loggedOut).toBe(false);
        expect(h.manager.has('a')).toBe(false);
        expect(await h.storage.keys(sessionPrefix('a'))).toEqual([]);
        expect(h.of('session.removed')).toEqual([['session.removed', { reason: 'deleted' }]]);
    });

    it('drops it from discovery too', async () => {
        const h = harness();
        await h.manager.create('a');

        await h.manager.remove('a');

        expect(await h.manager.discover()).toEqual([]);
    });
});

describe('SessionManager.logout', () => {
    it('unlinks the device and deregisters', async () => {
        const h = harness();
        await h.manager.create('a', { autoStart: true });
        await h.driver.last.open();

        await h.manager.logout('a');

        expect(h.driver.last.loggedOut).toBe(true);
        expect(h.manager.has('a')).toBe(false);
        expect(h.of('session.removed')).toEqual([['session.removed', { reason: 'logged_out' }]]);
    });

    it('keeps the session registered when the unlink fails', async () => {
        const h = harness();
        await h.manager.create('a', { autoStart: true });
        await h.driver.last.open();
        h.driver.last.logoutError = new Error('socket closed');

        await expect(h.manager.logout('a')).rejects.toMatchObject({ code: 'LOGOUT_FAILED' });

        expect(h.manager.has('a')).toBe(true);
    });
});

describe('SessionManager.load', () => {
    it('registers stored sessions this process has never opened', async () => {
        const storage = memoryStorage();
        const first = harness({}, storage);
        await first.manager.create('a');
        await first.manager.create('b');

        const second = harness({}, storage);
        const loaded = await second.manager.load();

        expect(loaded.map((session) => session.sessionId)).toEqual(['a', 'b']);
        expect(second.manager.ids().sort()).toEqual(['a', 'b']);
    });

    it('skips sessions that are already registered', async () => {
        const storage = memoryStorage();
        const h = harness({}, storage);
        await h.manager.create('a');

        const loaded = await h.manager.load();

        expect(loaded).toEqual([]);
        expect(h.manager.size).toBe(1);
    });

    it('leaves them stopped unless auto-start is configured', async () => {
        const storage = memoryStorage();
        await harness({}, storage).manager.create('a');

        const h = harness({}, storage);
        await h.manager.load();

        expect(h.manager.get('a').state).toBe('idle');
        expect(h.driver.sockets).toHaveLength(0);
    });

    it('starts them when auto-start is configured', async () => {
        const storage = memoryStorage();
        await harness({}, storage).manager.create('a');

        const h = harness({ load: { ...DEFAULT_CONFIG.load, autoStart: true } }, storage);
        await h.manager.load();

        expect(h.manager.get('a').state).toBe('connecting');
    });

    it('never exceeds the configured concurrency', async () => {
        // v1 fanned out with an unbounded Promise.all, so restoring a hundred
        // sessions opened a hundred sockets at once.
        const storage = memoryStorage();
        const seed = harness({}, storage);
        for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await seed.manager.create(id);

        let live = 0;
        let peak = 0;
        const h = harness({ load: { concurrency: 2, autoStart: true } }, storage);
        const driver = fakeDriver();
        const manager = new SessionManager({
            config: config({ load: { concurrency: 2, autoStart: true } }),
            storage,
            emitter: h.emitter,
            logger: silentLogger,
            socketFactory: async (options) => {
                live += 1;
                peak = Math.max(peak, live);
                await Promise.resolve();
                const socket = await driver.factory(options);
                live -= 1;
                return socket;
            },
        });

        await manager.load();

        expect(peak).toBeLessThanOrEqual(2);
        expect(manager.size).toBe(6);
    });
});

describe('SessionManager.destroy', () => {
    it('stops every session and clears the registry', async () => {
        const h = harness();
        await h.manager.create('a', { autoStart: true });
        await h.manager.create('b', { autoStart: true });

        await h.manager.destroy();

        expect(h.manager.size).toBe(0);
        expect(h.manager.destroyed).toBe(true);
        expect(h.driver.sockets.every((socket) => socket.ended)).toBe(true);
    });

    it('closes every adapter it was handed, exactly once', async () => {
        const close = vi.fn(() => Promise.resolve());
        const override = { ...memoryStorage(), name: 'override', close };
        const defaultClose = vi.fn(() => Promise.resolve());
        const h = harness({}, { ...memoryStorage(), close: defaultClose });
        await h.manager.create('a');
        await h.manager.create('b', { storage: override });
        await h.manager.create('c', { storage: override });

        await h.manager.destroy();

        expect(defaultClose).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('keeps going when one session fails to stop', async () => {
        // One failure must not strand the rest; v1 had no shutdown at all.
        const h = harness();
        const a = await h.manager.create('a', { autoStart: true });
        await h.manager.create('b', { autoStart: true });
        vi.spyOn(a, 'destroy').mockRejectedValueOnce(new Error('stuck'));

        await expect(h.manager.destroy()).resolves.toBeUndefined();

        expect(h.driver.sockets[1]?.ended).toBe(true);
    });

    it('keeps going when an adapter fails to close', async () => {
        const h = harness({}, { ...memoryStorage(), close: () => Promise.reject(new Error('busy')) });
        await h.manager.create('a');

        await expect(h.manager.destroy()).resolves.toBeUndefined();
    });

    it('is idempotent, and refuses further use', async () => {
        const h = harness();
        await h.manager.destroy();

        await expect(h.manager.destroy()).resolves.toBeUndefined();
        await expect(h.manager.create('a')).rejects.toMatchObject({ code: 'CLIENT_DESTROYED' });
        await expect(h.manager.load()).rejects.toMatchObject({ code: 'CLIENT_DESTROYED' });
    });
});

describe('SessionManager isolation', () => {
    it('gives each manager its own sessions', async () => {
        // v1 kept its sessions map in module scope, so two clients in one process
        // silently shared them.
        const storage = memoryStorage();
        const first = harness({}, storage);
        const second = harness({}, storage);

        await first.manager.create('a');

        expect(second.manager.has('a')).toBe(false);
        expect(first.manager.has('a')).toBe(true);
    });
});
