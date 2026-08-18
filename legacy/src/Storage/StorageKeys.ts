/**
 * Standard keys used across all storage adapters
 */
export const STORAGE_KEYS = {
    /** Authentication credentials */
    CREDS: 'creds',

    /** Session metadata (socket config, etc) */
    META: 'meta',

    /** Pre-key with ID */
    PRE_KEY: (id: string | number) => `pre-key-${id}`,

    /** Session key with ID */
    SESSION_KEY: (id: string | number) => `session-${id}`,

    /** App state sync key with ID */
    APP_STATE_SYNC_KEY: (id: string | number) => `app-state-sync-key-${id}`,

    /** Sender key with ID */
    SENDER_KEY: (id: string | number) => `sender-key-${id}`,

    /** App state sync version */
    APP_STATE_SYNC_VERSION: (id: string | number) => `app-state-sync-version-${id}`,

    /** Sender key memory with ID */
    SENDER_KEY_MEMORY: (id: string | number) => `sender-key-memory-${id}`,
} as const;

/**
 * Helper to parse key type and ID from storage key
 */
export function parseStorageKey(key: string): { type: string; id: string } | null {
    const match = key.match(/^(.+?)-(.+)$/);
    if (!match) return null;

    return {
        type: match[1],
        id: match[2],
    };
}

/**
 * Escape key for safe filesystem/database usage
 * Replaces: / → __ and : → -
 */
export function escapeKey(key: string): string {
    return key.replace(/\//g, '__').replace(/:/g, '-');
}

/**
 * Unescape key back to original format
 */
export function unescapeKey(key: string): string {
    return key.replace(/__/g, '/').replace(/-/g, ':');
}
