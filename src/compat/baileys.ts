/**
 * The sole Baileys touch point.
 *
 * We track the 7.0.0-rc line, which can break between release candidates. Funnelling
 * every driver-specific detail through this module makes an RC bump a one-file diff
 * plus a test run, instead of a sweep across the codebase. The daily
 * `baileys-drift` workflow is what tells us a bump is due.
 *
 * Nothing outside this directory may import from '@whiskeysockets/baileys'.
 */
import type {
    AnyMessageContent,
    AuthenticationCreds,
    AuthenticationState,
    BaileysEventMap,
    ConnectionState,
    SignalDataSet,
    SignalDataTypeMap,
    SocketConfig,
    UserFacingSocketConfig,
    WAMessage,
    WAMessageKey,
    WASocket,
} from '@whiskeysockets/baileys';

import { BAILEYS_MESSAGE_TO_CAUSE, BAILEYS_STATUS_TO_CAUSE, type DisconnectCause } from '../generated/index.js';

export type {
    AnyMessageContent,
    AuthenticationCreds,
    AuthenticationState,
    BaileysEventMap,
    ConnectionState,
    SignalDataSet,
    SignalDataTypeMap,
    SocketConfig,
    UserFacingSocketConfig,
    WAMessage,
    WAMessageKey,
    WASocket,
};

/**
 * The logger shape the driver expects. Derived from SocketConfig rather than imported
 * from the driver's internal path, which the package's exports map does not publish.
 */
export type ILogger = SocketConfig['logger'];

/**
 * Every key type in the Baileys v7 `SignalDataTypeMap`.
 *
 * `lid-mapping`, `device-list`, `tctoken` and `identity-key` are v7 additions. The
 * first three back the LID identity system that replaces phone numbers as the Signal
 * identity; a v6-shaped auth state has no slot for them, which is the reason this
 * rewrite targets v7 rather than the now-`legacy` v6 line.
 *
 * The compile-time `satisfies` below is the real guard: if a future Baileys release
 * adds or renames a key type, this file stops compiling.
 */
export const SIGNAL_KEY_TYPES = [
    'pre-key',
    'session',
    'sender-key',
    'sender-key-memory',
    'app-state-sync-key',
    'app-state-sync-version',
    'lid-mapping',
    'device-list',
    'tctoken',
    'identity-key',
] as const satisfies readonly (keyof SignalDataTypeMap)[];

export type SignalKeyType = (typeof SIGNAL_KEY_TYPES)[number];

/** Fails to compile if Baileys adds a key type we do not persist. */
type MissingKeyTypes = Exclude<keyof SignalDataTypeMap, SignalKeyType>;
const _allKeyTypesCovered: MissingKeyTypes extends never ? true : never = true;
void _allKeyTypesCovered;

/** Keys we own alongside the Signal material. */
export const RESERVED_KEYS = { creds: 'creds', meta: 'meta' } as const;

/**
 * Digs a numeric status out of whatever the driver threw. Baileys wraps disconnects
 * in a Boom, but the shape is not guaranteed across versions, and a plain Error is
 * possible -- so this reads defensively rather than casting. v1 cast straight to
 * Boom, which is why @hapi/boom was a runtime dependency for a single type
 * assertion.
 */
export function readStatusCode(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) return undefined;

    const output = (error as { output?: unknown }).output;
    if (typeof output === 'object' && output !== null) {
        const code = (output as { statusCode?: unknown }).statusCode;
        if (typeof code === 'number') return code;
    }

    const direct = (error as { statusCode?: unknown }).statusCode;
    return typeof direct === 'number' ? direct : undefined;
}

function readMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string') return message;
    }
    return '';
}

/**
 * Maps a Baileys disconnect onto the canonical cause both runtimes share.
 *
 * Message matching runs first, and exists for exactly one reason: Baileys assigns
 * 500 to both `badSession` and a plain server error. `bad_session` purges
 * credentials, so resolving 500 to it numerically would delete a working session on
 * any transient server error. The numeric map therefore sends 500 to `server_error`,
 * and `bad_session` is only reached when the payload actually says so.
 *
 * Behaviour is pinned by spec/vectors/disconnect-mapping.json, which the Go build
 * runs too.
 */
export function resolveDisconnectCause(error: unknown): DisconnectCause {
    const message = readMessage(error).toLowerCase();
    if (message.length > 0) {
        for (const [needle, cause] of BAILEYS_MESSAGE_TO_CAUSE) {
            if (message.includes(needle)) return cause;
        }
    }

    const status = readStatusCode(error);
    if (status === undefined) return 'unknown';
    return BAILEYS_STATUS_TO_CAUSE[status] ?? 'unknown';
}
