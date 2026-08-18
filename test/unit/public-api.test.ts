import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as api from '../../src/index.js';
import * as mongo from '../../src/adapters/mongo/index.js';
import * as redis from '../../src/adapters/redis/index.js';
import * as sqlAdapter from '../../src/adapters/sql/index.js';
import * as qr from '../../src/qr/index.js';
import { ERROR_CODES, LIFECYCLE_EVENTS } from '../../src/generated/index.js';

/**
 * The barrel is the package's contract. Importing it here proves every re-export
 * path actually resolves at runtime, and makes an accidental removal a failing test
 * rather than a consumer's problem.
 */
describe('public surface', () => {
    const expected = [
        // client
        'WhatsMulti',
        // spec surface
        'SPEC_VERSION',
        'SESSION_STATES',
        'SESSION_TRIGGERS',
        'INITIAL_STATE',
        'TERMINAL_STATES',
        'SENDABLE_STATES',
        'PAIRABLE_STATES',
        'TRANSITIONS',
        'DISCONNECT_CAUSES',
        'DISCONNECT_ACTIONS',
        'PURGES_CREDS',
        'ERROR_CODES',
        'ERROR_MESSAGES',
        'ERROR_RETRYABLE',
        'LIFECYCLE_EVENTS',
        'WIRE_EVENTS',
        // errors
        'WhatsMultiError',
        'formatErrorMessage',
        'isWhatsMultiError',
        'hasErrorCode',
        'wrapError',
        'describeError',
        // logging
        'createLogger',
        'silentLogger',
        'resolveLogger',
        'isLogLevel',
        'LOG_LEVELS',
        // configuration
        'resolveConfig',
        'generateInstanceId',
        'isValidSessionId',
        'assertValidSessionId',
        'DEFAULT_CONFIG',
        'SESSION_ID_PATTERN',
        // storage
        'memoryStorage',
        'fileStorage',
        'resolveStorage',
        'DEFAULT_STORAGE_PATH',
        'NAMESPACE',
        'SEPARATOR',
        'encodeKey',
        'decodeKey',
        'sessionPrefix',
        'namespacePrefix',
        'storageKey',
        'parseStorageKey',
        'requireStorageKey',
        // auth
        'useAuthState',
        'CREDS_KEY',
        'META_KEY',
        'RESERVED_KEY_NAMES',
        'STORAGE_KEYS',
        'isReservedKey',
        'isSignalKeyType',
        'parseSignalKey',
        'signalKey',
        'encodeValue',
        'decodeValue',
        'encodeJson',
        'decodeJson',
        'bufferReplacer',
        'bufferReviver',
        // sessions
        'Session',
        'SessionManager',
        'SessionMachine',
        'SessionRegistry',
        'ReconnectPolicy',
        'backoffDelay',
        'createSocket',
        'decideDisconnect',
        'decisionFor',
        'disconnectTrigger',
        'formatPairingCode',
        'isPairable',
        'isSendable',
        'isSessionState',
        'isTerminal',
        'memoryLock',
        'nextState',
        'sessionLockKey',
        'toDriverLogger',
        // messaging
        'DEFAULT_SERVER',
        'KNOWN_SERVERS',
        'SendQueue',
        'downloadMedia',
        'downloadMediaStream',
        'isJid',
        'isKnownServer',
        'normalizeJid',
        'normalizePhoneNumber',
        'parseJid',
        'sendMessage',
        // utilities
        'mapLimit',
        'withTimeout',
        'createRandom',
        'mulberry32',
        'randomSeed',
        // events
        'WMEventEmitter',
        // plugins
        'PluginRegistry',
        'definePlugin',
        // driver compatibility
        'SIGNAL_KEY_TYPES',
        'RESERVED_KEYS',
        'resolveDisconnectCause',
        'readStatusCode',
        'loadDriver',
        'setDriverLoader',
    ] as const;

    it.each(expected)('exports %s', (name) => {
        expect(api).toHaveProperty(name);
        expect(api[name]).toBeDefined();
    });

    it('exports nothing beyond the documented surface', () => {
        expect(Object.keys(api).sort()).toEqual([...expected].sort());
    });

    it('does not leak the Baileys namespace to consumers', () => {
        // Everything driver-specific goes through src/compat, so an RC bump stays a
        // one-file change.
        expect(Object.keys(api)).not.toContain('makeWASocket');
        expect(Object.keys(api)).not.toContain('DisconnectReason');
    });

    it('re-exports the generated constants by identity, not by copy', () => {
        expect(api.ERROR_CODES).toBe(ERROR_CODES);
        expect(api.LIFECYCLE_EVENTS).toBe(LIFECYCLE_EVENTS);
    });
});

/**
 * The second entry point. Pinned here rather than left to the packaging check,
 * because a subpath that stops resolving is only visible to a consumer.
 */
describe('the qr entry point', () => {
    it('exports exactly the renderers', () => {
        expect(Object.keys(qr).sort()).toEqual([
            'loadQrRenderer',
            'printQr',
            'setQrLoader',
            'toBuffer',
            'toDataURL',
            'toSvg',
            'toTerminal',
        ]);
    });

    it('is published on the exports map', () => {
        const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
            exports: Record<string, unknown>;
        };
        expect(manifest.exports['./qr']).toEqual({
            types: './dist/qr/index.d.ts',
            default: './dist/qr/index.js',
        });
    });
});

/**
 * The adapter entry points. Each is its own subpath so that installing the package
 * never pulls in a database driver, and importing one is what says which driver a
 * consumer has.
 */
describe('the adapter entry points', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
        exports: Record<string, unknown>;
        peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };

    it.each([
        ['./mongo', mongo, ['mongoLock', 'mongoStorage'], 'mongodb'],
        ['./redis', redis, ['RELEASE_SCRIPT', 'RENEW_SCRIPT', 'redisLock', 'redisStorage'], 'ioredis'],
        ['./sql', sqlAdapter, ['sqlLock', 'sqlStorage'], 'drizzle-orm'],
    ])('%s exports its adapter pair and rests on an optional peer', (subpath, module, expected, peer) => {
        expect(Object.keys(module).sort()).toEqual(expected);
        expect(manifest.exports[subpath]).toEqual({
            types: `./dist/adapters/${subpath.slice(2)}/index.d.ts`,
            default: `./dist/adapters/${subpath.slice(2)}/index.js`,
        });
        expect(manifest.peerDependenciesMeta[peer]?.optional).toBe(true);
    });

    it('keeps the drivers out of the main entry point', () => {
        // Importing the package must not require a database. The adapters are reached
        // by subpath precisely so that installing one is a choice.
        expect(Object.keys(api)).not.toContain('mongoStorage');
        expect(Object.keys(api)).not.toContain('redisStorage');
        expect(Object.keys(api)).not.toContain('sqlStorage');
    });
});
