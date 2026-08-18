import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
    assertValidSessionId,
    DEFAULT_CONFIG,
    generateInstanceId,
    isValidSessionId,
    resolveConfig,
} from '../../src/config.js';
import { hasErrorCode, isWhatsMultiError, WhatsMultiError } from '../../src/errors.js';

const spec = parse(readFileSync(join(process.cwd(), 'spec', 'config.yaml'), 'utf8')) as Record<string, never>;

const specDefault = (path: string): unknown =>
    path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], spec);

describe('defaults match spec/config.yaml', () => {
    // The Go build reads the same file. If these drift, the two runtimes disagree
    // about what "default" means, which is the exact failure this rewrite exists to
    // prevent.
    it.each([
        ['log_level.default', DEFAULT_CONFIG.logLevel],
        ['driver_log_level.default', DEFAULT_CONFIG.driverLogLevel],
        ['reconnect.enabled.default', DEFAULT_CONFIG.reconnect.enabled],
        ['reconnect.base_ms.default', DEFAULT_CONFIG.reconnect.baseMs],
        ['reconnect.cap_ms.default', DEFAULT_CONFIG.reconnect.capMs],
        ['reconnect.floor_ms.default', DEFAULT_CONFIG.reconnect.floorMs],
        ['reconnect.max_attempts.default', DEFAULT_CONFIG.reconnect.maxAttempts],
        ['qr.timeout_ms.default', DEFAULT_CONFIG.qr.timeoutMs],
        ['qr.max_attempts.default', DEFAULT_CONFIG.qr.maxAttempts],
        ['qr.print.default', DEFAULT_CONFIG.qr.print],
        ['pairing.enabled.default', DEFAULT_CONFIG.pairing.enabled],
        ['pairing.show_notification.default', DEFAULT_CONFIG.pairing.showNotification],
        ['pairing.client_display_name.default', DEFAULT_CONFIG.pairing.clientDisplayName],
        ['send.concurrency.default', DEFAULT_CONFIG.send.concurrency],
        ['send.min_delay_ms.default', DEFAULT_CONFIG.send.minDelayMs],
        ['send.timeout_ms.default', DEFAULT_CONFIG.send.timeoutMs],
        ['send.max_queue.default', DEFAULT_CONFIG.send.maxQueue],
        ['lock.enabled.default', DEFAULT_CONFIG.lock.enabled],
        ['lock.ttl_ms.default', DEFAULT_CONFIG.lock.ttlMs],
        ['lock.renew_ratio.default', DEFAULT_CONFIG.lock.renewRatio],
        ['load.concurrency.default', DEFAULT_CONFIG.load.concurrency],
        ['load.auto_start.default', DEFAULT_CONFIG.load.autoStart],
    ])('%s', (path, value) => {
        expect(specDefault(path)).toBe(value);
    });

    it.each([
        ['reconnect.base_ms.min', 'reconnect', 'baseMs'],
        ['reconnect.cap_ms.min', 'reconnect', 'capMs'],
        ['qr.timeout_ms.min', 'qr', 'timeoutMs'],
        ['qr.max_attempts.min', 'qr', 'maxAttempts'],
        ['send.concurrency.min', 'send', 'concurrency'],
        ['send.timeout_ms.min', 'send', 'timeoutMs'],
        ['lock.ttl_ms.min', 'lock', 'ttlMs'],
        ['load.concurrency.min', 'load', 'concurrency'],
    ] as const)('rejects a value below the spec minimum for %s', (path, section, key) => {
        const min = specDefault(path) as number;
        expect(() => resolveConfig({ [section]: { [key]: min - 1 } })).toThrowError(WhatsMultiError);
    });
});

describe('resolveConfig', () => {
    it('fills every section with defaults', () => {
        const config = resolveConfig();
        expect(config.reconnect).toEqual(DEFAULT_CONFIG.reconnect);
        expect(config.qr).toEqual(DEFAULT_CONFIG.qr);
        expect(config.send).toEqual(DEFAULT_CONFIG.send);
        expect(config.lock).toEqual(DEFAULT_CONFIG.lock);
        expect(config.load).toEqual(DEFAULT_CONFIG.load);
        expect(config.pairing).toEqual(DEFAULT_CONFIG.pairing);
    });

    it('merges a partial section without dropping its siblings', () => {
        const config = resolveConfig({ reconnect: { capMs: 5000 } });
        expect(config.reconnect.capMs).toBe(5000);
        expect(config.reconnect.baseMs).toBe(DEFAULT_CONFIG.reconnect.baseMs);
    });

    it('generates a distinct instanceId per client', () => {
        expect(resolveConfig().instanceId).not.toBe(resolveConfig().instanceId);
        expect(resolveConfig({ instanceId: 'fixed' }).instanceId).toBe('fixed');
    });

    it('freezes the result, so two clients cannot share mutable state', () => {
        const config = resolveConfig();
        expect(Object.isFrozen(config)).toBe(true);
        expect(Object.isFrozen(config.reconnect)).toBe(true);
    });

    it('reports the offending path and a readable detail', () => {
        try {
            resolveConfig({ send: { concurrency: 0 } });
            expect.unreachable();
        } catch (error) {
            expect(isWhatsMultiError(error)).toBe(true);
            expect(hasErrorCode(error, 'INVALID_CONFIG')).toBe(true);
            expect((error as WhatsMultiError).message).toContain('send.concurrency');
            expect((error as WhatsMultiError).message).toContain('must be >= 1');
        }
    });

    it.each([
        ['a non-integer', { send: { concurrency: 1.5 } }],
        ['a non-number', { send: { concurrency: '1' as unknown as number } }],
        ['NaN', { send: { concurrency: Number.NaN } }],
        ['Infinity', { send: { concurrency: Number.POSITIVE_INFINITY } }],
        ['a non-boolean', { qr: { print: 'yes' as unknown as boolean } }],
        ['an empty string', { instanceId: '' }],
        ['an unknown log level', { logLevel: 'verbose' as never }],
    ])('rejects %s', (_label, input) => {
        expect(() => resolveConfig(input)).toThrowError(WhatsMultiError);
    });

    it('rejects a cap below the base, which would make the exponent meaningless', () => {
        expect(() => resolveConfig({ reconnect: { baseMs: 30_000, capMs: 1000 } })).toThrowError(/cap_ms/);
    });

    it.each([0, 1, 1.5, -0.5])('rejects a renew ratio of %s', (renewRatio) => {
        // Outside (0,1) the lock either renews continuously or only after it has
        // already expired, and an expired lock is a lost lock.
        expect(() => resolveConfig({ lock: { renewRatio } })).toThrowError(/renew_ratio/);
    });

    it('accepts an explicit undefined for an optional key', () => {
        expect(() => resolveConfig({ reconnect: { capMs: undefined }, instanceId: undefined })).not.toThrow();
    });
});

describe('session ids', () => {
    it.each(['a', 'session-1', 'session_1', 'A-Z_0-9', 'x'.repeat(64)])('accepts %s', (id) => {
        expect(isValidSessionId(id)).toBe(true);
    });

    it.each(['', 'x'.repeat(65), 'has space', 'has:colon', 'has/slash', 'has%percent', 'has@at', 'has.dot'])(
        'rejects %s',
        (id) => {
            expect(isValidSessionId(id)).toBe(false);
            expect(() => assertValidSessionId(id)).toThrowError(WhatsMultiError);
        }
    );

    it('excludes every character the storage key layout treats as structural', () => {
        // This is why storage keys only ever escape the key half.
        for (const char of [':', '/', '%']) expect(isValidSessionId(`a${char}b`)).toBe(false);
    });
});

describe('generateInstanceId', () => {
    it('is host:pid:random and unique per call', () => {
        expect(generateInstanceId()).toMatch(/^.+:\d+:[0-9a-f]{6}$/);
        expect(generateInstanceId()).not.toBe(generateInstanceId());
    });
});
