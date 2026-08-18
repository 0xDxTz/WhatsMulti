import { describe, expect, it } from 'vitest';

import * as api from '../../src/index.js';
import { ERROR_CODES, LIFECYCLE_EVENTS } from '../../src/generated/index.js';

/**
 * The barrel is the package's contract. Importing it here proves every re-export
 * path actually resolves at runtime, and makes an accidental removal a failing test
 * rather than a consumer's problem.
 */
describe('public surface', () => {
    const expected = [
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
