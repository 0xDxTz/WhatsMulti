import { describe, expect, it, vi } from 'vitest';

import { createLogger, isLogLevel, LOG_LEVELS, resolveLogger, silentLogger } from '../../src/logger.js';

function sink() {
    const lines: string[] = [];
    return { lines, write: (line: string) => void lines.push(line) };
}

describe('createLogger', () => {
    it('filters by severity', () => {
        const { lines, write } = sink();
        const logger = createLogger({ level: 'warn', write });

        logger.error('an error');
        logger.warn('a warning');
        logger.info('info');
        logger.debug('debug');
        logger.trace('trace');

        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('an error');
        expect(lines[1]).toContain('a warning');
    });

    it('emits nothing at silent', () => {
        const { lines, write } = sink();
        const logger = createLogger({ level: 'silent', write });
        for (const level of ['error', 'warn', 'info', 'debug', 'trace'] as const) logger[level]('x');
        expect(lines).toEqual([]);
    });

    it('accepts both the (msg) and (obj, msg) call shapes', () => {
        const { lines, write } = sink();
        const logger = createLogger({ level: 'trace', write });

        logger.info('bare');
        logger.info({ sessionId: 'a' }, 'with context');

        expect(lines[0]).toContain('bare');
        expect(lines[1]).toContain('with context');
        expect(lines[1]).toContain('"sessionId":"a"');
    });

    it('writes to stderr by default so a piped stdout stays clean', () => {
        const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        createLogger({ level: 'info' }).info('hello');
        expect(spy).toHaveBeenCalledOnce();
        spy.mockRestore();
    });

    it('includes the logger name and a timestamp', () => {
        const { lines, write } = sink();
        createLogger({ level: 'info', name: 'custom', write }).info('msg');
        expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} INFO {2}\[custom\] msg\n$/);
    });

    it('merges child bindings into every line', () => {
        const { lines, write } = sink();
        const child = createLogger({ level: 'info', write }).child({ sessionId: 'a' });

        child.info('one');
        child.info({ attempt: 2 }, 'two');
        child.child({ plugin: 'webhook' }).info('three');

        expect(lines[0]).toContain('"sessionId":"a"');
        expect(lines[1]).toContain('"attempt":2');
        expect(lines[2]).toContain('"plugin":"webhook"');
        expect(lines[2]).toContain('"sessionId":"a"');
    });

    it('serialises an Error rather than dropping it to {}', () => {
        const { lines, write } = sink();
        createLogger({ level: 'error', write }).error({ err: new Error('boom') }, 'failed');
        expect(lines[0]).toContain('"message":"boom"');
        expect(lines[0]).toContain('"name":"Error"');
    });

    it('never throws on a circular payload', () => {
        const { lines, write } = sink();
        const circular: Record<string, unknown> = { a: 1 };
        circular['self'] = circular;

        expect(() => createLogger({ level: 'info', write }).info(circular, 'circular')).not.toThrow();
        expect(lines[0]).toContain('[Circular]');
    });

    it('serialises a bigint', () => {
        const { lines, write } = sink();
        createLogger({ level: 'info', write }).info({ big: 1n }, 'big');
        expect(lines[0]).toContain('"big":"1"');
    });
});

describe('silentLogger', () => {
    it('is inert and returns itself from child', () => {
        expect(() => silentLogger.error({ a: 1 }, 'x')).not.toThrow();
        expect(silentLogger.child({ a: 1 })).toBe(silentLogger);
    });
});

describe('resolveLogger', () => {
    it('prefers an injected logger', () => {
        expect(resolveLogger(silentLogger, 'debug')).toBe(silentLogger);
    });

    it('short-circuits to the inert logger at silent', () => {
        expect(resolveLogger(undefined, 'silent')).toBe(silentLogger);
    });

    it('builds a console logger otherwise', () => {
        const logger = resolveLogger(undefined, 'info', 'named');
        expect(logger).not.toBe(silentLogger);
        expect(typeof logger.child).toBe('function');
    });
});

describe('isLogLevel', () => {
    it('accepts every documented level and rejects the rest', () => {
        for (const level of LOG_LEVELS) expect(isLogLevel(level)).toBe(true);
        for (const value of ['fatal', 'verbose', '', 1, null, undefined]) expect(isLogLevel(value)).toBe(false);
    });
});
