import { WhatsMultiError } from '../errors.js';
import type { StorageAdapter, StorageInput } from './adapter.js';
import { fileStorage } from './file.js';
import { memoryStorage } from './memory.js';

const isAdapter = (value: unknown): value is StorageAdapter =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StorageAdapter).name === 'string' &&
    typeof (value as StorageAdapter).get === 'function' &&
    typeof (value as StorageAdapter).mget === 'function' &&
    typeof (value as StorageAdapter).keys === 'function';

/**
 * Turns the configured value into an adapter. The shorthands exist so the common
 * cases stay one word; anything else is an adapter instance the caller constructs,
 * which is what keeps mongo, redis and sql out of core.
 */
export function resolveStorage(input: StorageInput): StorageAdapter {
    if (input === 'memory') return memoryStorage();
    if (input === 'file') return fileStorage();
    if (isAdapter(input)) return input;

    throw new WhatsMultiError('INVALID_CONFIG', {
        params: {
            path: 'storage',
            detail: `expected "memory", "file", or a StorageAdapter, received ${typeof input}`,
        },
    });
}
