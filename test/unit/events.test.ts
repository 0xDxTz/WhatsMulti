import { describe, expect, it, vi } from 'vitest';

import { WMEventEmitter } from '../../src/events/emitter.js';
import type { EventMeta, SessionErrorEvent } from '../../src/events/types.js';
import { WhatsMultiError } from '../../src/errors.js';
import { createLogger, silentLogger } from '../../src/logger.js';

const meta: EventMeta = { sessionId: 'a', instanceId: 'host:1:abc', ts: 1_755_500_000_000 };

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('subscription', () => {
    it('delivers data and meta to a listener', () => {
        const emitter = new WMEventEmitter();
        const seen = vi.fn();

        emitter.on('session.fenced', seen);
        emitter.emit('session.fenced', { owner: 'other' }, meta);

        expect(seen).toHaveBeenCalledExactlyOnceWith({ owner: 'other' }, meta);
    });

    it('off removes the listener despite the internal wrapper', () => {
        const emitter = new WMEventEmitter();
        const seen = vi.fn();

        emitter.on('session.fenced', seen);
        emitter.off('session.fenced', seen);
        emitter.emit('session.fenced', { owner: 'other' }, meta);

        expect(seen).not.toHaveBeenCalled();
        expect(emitter.listenerCount('session.fenced')).toBe(0);
    });

    it('off is a no-op for a listener that was never registered', () => {
        const emitter = new WMEventEmitter();
        expect(() => emitter.off('session.fenced', vi.fn())).not.toThrow();
    });

    it('once fires exactly once', () => {
        const emitter = new WMEventEmitter();
        const seen = vi.fn();

        emitter.once('session.fenced', seen);
        emitter.emit('session.fenced', { owner: 'x' }, meta);
        emitter.emit('session.fenced', { owner: 'y' }, meta);

        expect(seen).toHaveBeenCalledOnce();
        expect(emitter.listenerCount('session.fenced')).toBe(0);
    });

    it('removeAllListeners clears per-event and global subscriptions', () => {
        const emitter = new WMEventEmitter();
        const single = vi.fn();
        const batch = vi.fn();

        emitter.on('session.fenced', single);
        emitter.process(batch);
        emitter.removeAllListeners('session.fenced');
        emitter.emit('session.fenced', { owner: 'x' }, meta);
        expect(single).not.toHaveBeenCalled();
        expect(batch).toHaveBeenCalledOnce();

        emitter.removeAllListeners();
        emitter.emit('session.fenced', { owner: 'x' }, meta);
        expect(batch).toHaveBeenCalledOnce();
    });
});

describe('batching', () => {
    it('hands process() the driver batch intact', () => {
        // v1 re-split the batch into one call per event, discarding the buffering
        // Baileys works to provide.
        const emitter = new WMEventEmitter();
        const batch = vi.fn();
        emitter.process(batch);

        const events = { 'session.fenced': { owner: 'x' }, qr: { qr: 'code', attempt: 1, expiresAt: 0 } };
        emitter.emitBatch(events, meta);

        expect(batch).toHaveBeenCalledExactlyOnceWith(events, meta);
    });

    it('still fans the batch out to per-event listeners', () => {
        const emitter = new WMEventEmitter();
        const onQr = vi.fn();
        const onFenced = vi.fn();

        emitter.on('qr', onQr);
        emitter.on('session.fenced', onFenced);
        emitter.emitBatch({ qr: { qr: 'c', attempt: 1, expiresAt: 0 }, 'session.fenced': { owner: 'x' } }, meta);

        expect(onQr).toHaveBeenCalledOnce();
        expect(onFenced).toHaveBeenCalledOnce();
    });

    it('presents a single emit as a batch of one', () => {
        const emitter = new WMEventEmitter();
        const batch = vi.fn();
        emitter.process(batch);
        emitter.emit('session.fenced', { owner: 'x' }, meta);
        expect(batch).toHaveBeenCalledExactlyOnceWith({ 'session.fenced': { owner: 'x' } }, meta);
    });

    it('skips undefined entries in a sparse batch', () => {
        const emitter = new WMEventEmitter();
        const onQr = vi.fn();
        emitter.on('qr', onQr);
        emitter.emitBatch({ qr: undefined }, meta);
        expect(onQr).not.toHaveBeenCalled();
    });

    it('process returns an unsubscribe function', () => {
        const emitter = new WMEventEmitter();
        const batch = vi.fn();
        const stop = emitter.process(batch);

        emitter.emit('session.fenced', { owner: 'x' }, meta);
        stop();
        emitter.emit('session.fenced', { owner: 'y' }, meta);

        expect(batch).toHaveBeenCalledOnce();
    });
});

describe('listener isolation', () => {
    it('a throwing listener does not stop the others', () => {
        const emitter = new WMEventEmitter();
        const after = vi.fn();

        emitter.on('session.fenced', () => {
            throw new Error('listener exploded');
        });
        emitter.on('session.fenced', after);

        expect(() => emitter.emit('session.fenced', { owner: 'x' }, meta)).not.toThrow();
        expect(after).toHaveBeenCalledOnce();
    });

    it('reports a throw as session.error with LISTENER_FAILED', () => {
        const emitter = new WMEventEmitter();
        const errors: SessionErrorEvent[] = [];

        emitter.on('session.error', (data) => void errors.push(data));
        emitter.on('session.fenced', () => {
            throw new Error('listener exploded');
        });
        emitter.emit('session.fenced', { owner: 'x' }, meta);

        expect(errors).toHaveLength(1);
        expect(errors[0]?.code).toBe('LISTENER_FAILED');
        expect(errors[0]?.message).toContain('session.fenced');
        expect(errors[0]?.message).toContain('listener exploded');
    });

    it('preserves our own error code when the listener throws one', () => {
        const emitter = new WMEventEmitter();
        const errors: SessionErrorEvent[] = [];

        emitter.on('session.error', (data) => void errors.push(data));
        emitter.on('session.fenced', () => {
            throw new WhatsMultiError('STORAGE_ERROR', { params: { adapter: 'mongo' } });
        });
        emitter.emit('session.fenced', { owner: 'x' }, meta);

        expect(errors[0]?.code).toBe('STORAGE_ERROR');
    });

    it('catches a rejected async listener instead of leaving it unhandled', async () => {
        // On Node an unhandled rejection terminates the process by default, so v1's
        // bare async listeners made a handler bug fatal.
        const emitter = new WMEventEmitter();
        const errors: SessionErrorEvent[] = [];

        emitter.on('session.error', (data) => void errors.push(data));
        emitter.on('session.fenced', () => Promise.reject(new Error('async boom')));
        emitter.emit('session.fenced', { owner: 'x' }, meta);

        await flush();
        expect(errors[0]?.code).toBe('LISTENER_FAILED');
        expect(errors[0]?.message).toContain('async boom');
    });

    it('does not recurse when a session.error listener itself throws', () => {
        const emitter = new WMEventEmitter();
        let calls = 0;

        emitter.on('session.error', () => {
            calls++;
            throw new Error('reporting failed');
        });
        emitter.on('session.fenced', () => {
            throw new Error('original');
        });

        expect(() => emitter.emit('session.fenced', { owner: 'x' }, meta)).not.toThrow();
        expect(calls).toBe(1);
    });

    it('does not re-enter a failing process() listener', () => {
        const emitter = new WMEventEmitter();
        let calls = 0;

        emitter.process(() => {
            calls++;
            throw new Error('batch listener exploded');
        });

        expect(() => emitter.emit('session.fenced', { owner: 'x' }, meta)).not.toThrow();
        expect(calls).toBe(1);
    });

    it('logs every listener failure', () => {
        const lines: string[] = [];
        const emitter = new WMEventEmitter({
            logger: createLogger({ level: 'error', write: (line) => void lines.push(line) }),
        });

        emitter.on('session.fenced', () => {
            throw new Error('boom');
        });
        emitter.emit('session.fenced', { owner: 'x' }, meta);

        expect(lines[0]).toContain('event listener failed');
        expect(lines[0]).toContain('session.fenced');
    });

    it('accepts a logger set after construction', () => {
        const lines: string[] = [];
        const emitter = new WMEventEmitter({ logger: silentLogger });
        emitter.setLogger(createLogger({ level: 'error', write: (line) => void lines.push(line) }));

        emitter.on('session.fenced', () => {
            throw new Error('boom');
        });
        emitter.emit('session.fenced', { owner: 'x' }, meta);

        expect(lines).toHaveLength(1);
    });
});

describe('no error event name', () => {
    it('emitting with no listener attached does not throw', () => {
        // Node's EventEmitter throws when 'error' is emitted unhandled, which turns a
        // reporting path into a crash path. We never use that name.
        const emitter = new WMEventEmitter();
        emitter.on('session.fenced', () => {
            throw new Error('boom');
        });
        expect(() => emitter.emit('session.fenced', { owner: 'x' }, meta)).not.toThrow();
    });
});
