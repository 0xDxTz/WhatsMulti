import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

import { WhatsMultiError } from './errors.js';
import { isLogLevel, LOG_LEVELS, type Logger, type LogLevel } from './logger.js';

/**
 * Configuration mirrors spec/config.yaml, which is the authoritative list of keys,
 * types and defaults. Wire form is snake_case; code form is camelCase. A test asserts
 * every default here equals the spec, so the Go build and this one cannot disagree
 * about what "default" means.
 *
 * Everything is validated and frozen at construction. v1 kept a module-global,
 * mutable config that two client instances silently shared.
 */

/** Optional in the `exactOptionalPropertyTypes` sense: the key may also be present-but-undefined. */
type Options<T> = { readonly [K in keyof T]?: T[K] | undefined };

export interface ReconnectConfig {
    readonly enabled: boolean;
    readonly baseMs: number;
    readonly capMs: number;
    readonly floorMs: number;
    /** 0 means unlimited. */
    readonly maxAttempts: number;
}

export interface QrConfig {
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly print: boolean;
}

export interface PairingConfig {
    readonly enabled: boolean;
    readonly showNotification: boolean;
    /** Must read `Browser (OS)`; WhatsApp validates it and rejects anything else. */
    readonly clientDisplayName: string;
}

export interface SendConfig {
    readonly concurrency: number;
    readonly minDelayMs: number;
    readonly timeoutMs: number;
    readonly maxQueue: number;
}

export interface LockConfig {
    readonly enabled: boolean;
    readonly ttlMs: number;
    readonly renewRatio: number;
}

export interface LoadConfig {
    readonly concurrency: number;
    readonly autoStart: boolean;
}

export interface ResolvedConfig {
    readonly instanceId: string;
    readonly logLevel: LogLevel;
    readonly driverLogLevel: LogLevel;
    readonly reconnect: ReconnectConfig;
    readonly qr: QrConfig;
    readonly pairing: PairingConfig;
    readonly send: SendConfig;
    readonly lock: LockConfig;
    readonly load: LoadConfig;
}

export interface WhatsMultiConfig {
    readonly instanceId?: string | undefined;
    /** Any pino-compatible logger. Omit to get the built-in zero-dependency one. */
    readonly logger?: Logger | undefined;
    readonly logLevel?: LogLevel | undefined;
    readonly driverLogLevel?: LogLevel | undefined;
    readonly reconnect?: Options<ReconnectConfig> | undefined;
    readonly qr?: Options<QrConfig> | undefined;
    readonly pairing?: Options<PairingConfig> | undefined;
    readonly send?: Options<SendConfig> | undefined;
    readonly lock?: Options<LockConfig> | undefined;
    readonly load?: Options<LoadConfig> | undefined;
}

/** spec/config.yaml#session_id.pattern */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The pattern deliberately excludes `:`, `/` and `%`, which is why storage keys only
 * ever have to escape the key half. See spec/algorithms.md section 3.
 */
export function isValidSessionId(id: string): boolean {
    return SESSION_ID_PATTERN.test(id);
}

export function assertValidSessionId(id: string): void {
    if (!isValidSessionId(id)) throw new WhatsMultiError('INVALID_SESSION_ID', { params: { sessionId: id } });
}

export const DEFAULT_CONFIG: ResolvedConfig = {
    instanceId: '',
    logLevel: 'info',
    driverLogLevel: 'silent',
    reconnect: { enabled: true, baseMs: 1000, capMs: 60_000, floorMs: 250, maxAttempts: 0 },
    qr: { timeoutMs: 60_000, maxAttempts: 5, print: false },
    pairing: { enabled: false, showNotification: true, clientDisplayName: 'Chrome (Linux)' },
    send: { concurrency: 1, minDelayMs: 0, timeoutMs: 30_000, maxQueue: 1000 },
    lock: { enabled: true, ttlMs: 30_000, renewRatio: 0.33 },
    load: { concurrency: 8, autoStart: false },
};

// --------------------------------------------------------------------- validation

const invalid = (path: string, detail: string) => new WhatsMultiError('INVALID_CONFIG', { params: { path, detail } });

interface NumberRule {
    readonly min?: number;
    readonly max?: number;
    readonly integer?: boolean;
}

function num(path: string, value: unknown, fallback: number, rule: NumberRule = {}): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalid(path, `expected a finite number, received ${typeof value}`);
    }
    if (rule.integer !== false && !Number.isInteger(value))
        throw invalid(path, `expected an integer, received ${value}`);
    if (rule.min !== undefined && value < rule.min) throw invalid(path, `must be >= ${rule.min}, received ${value}`);
    if (rule.max !== undefined && value > rule.max) throw invalid(path, `must be <= ${rule.max}, received ${value}`);
    return value;
}

function bool(path: string, value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw invalid(path, `expected a boolean, received ${typeof value}`);
    return value;
}

function str(path: string, value: unknown, fallback: string): string {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value.length === 0) throw invalid(path, 'expected a non-empty string');
    return value;
}

function level(path: string, value: unknown, fallback: LogLevel): LogLevel {
    if (value === undefined) return fallback;
    if (!isLogLevel(value)) {
        const received = typeof value === 'string' ? `"${value}"` : typeof value;
        throw invalid(path, `expected one of ${LOG_LEVELS.join(', ')}, received ${received}`);
    }
    return value;
}

export function generateInstanceId(): string {
    return `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
}

export function resolveConfig(input: WhatsMultiConfig = {}): ResolvedConfig {
    const d = DEFAULT_CONFIG;

    const reconnect: ReconnectConfig = {
        enabled: bool('reconnect.enabled', input.reconnect?.enabled, d.reconnect.enabled),
        baseMs: num('reconnect.base_ms', input.reconnect?.baseMs, d.reconnect.baseMs, { min: 100 }),
        capMs: num('reconnect.cap_ms', input.reconnect?.capMs, d.reconnect.capMs, { min: 1000 }),
        floorMs: num('reconnect.floor_ms', input.reconnect?.floorMs, d.reconnect.floorMs, { min: 0 }),
        maxAttempts: num('reconnect.max_attempts', input.reconnect?.maxAttempts, d.reconnect.maxAttempts, { min: 0 }),
    };

    // Not expressible as a per-field range: a cap below the base makes the exponential
    // term meaningless, and the vectors assume cap >= base.
    if (reconnect.capMs < reconnect.baseMs) {
        throw invalid('reconnect.cap_ms', `must be >= reconnect.base_ms (${reconnect.baseMs})`);
    }

    const lock: LockConfig = {
        enabled: bool('lock.enabled', input.lock?.enabled, d.lock.enabled),
        ttlMs: num('lock.ttl_ms', input.lock?.ttlMs, d.lock.ttlMs, { min: 5000 }),
        renewRatio: num('lock.renew_ratio', input.lock?.renewRatio, d.lock.renewRatio, { integer: false }),
    };

    // A ratio outside (0, 1) either renews continuously or only after expiry, and an
    // expired lock has already been lost.
    if (lock.renewRatio <= 0 || lock.renewRatio >= 1) {
        throw invalid('lock.renew_ratio', `must be between 0 and 1 exclusive, received ${lock.renewRatio}`);
    }

    return Object.freeze({
        instanceId: str('instance_id', input.instanceId, generateInstanceId()),
        logLevel: level('log_level', input.logLevel, d.logLevel),
        driverLogLevel: level('driver_log_level', input.driverLogLevel, d.driverLogLevel),
        reconnect: Object.freeze(reconnect),
        qr: Object.freeze({
            timeoutMs: num('qr.timeout_ms', input.qr?.timeoutMs, d.qr.timeoutMs, { min: 5000 }),
            maxAttempts: num('qr.max_attempts', input.qr?.maxAttempts, d.qr.maxAttempts, { min: 1 }),
            print: bool('qr.print', input.qr?.print, d.qr.print),
        }),
        pairing: Object.freeze({
            enabled: bool('pairing.enabled', input.pairing?.enabled, d.pairing.enabled),
            showNotification: bool(
                'pairing.show_notification',
                input.pairing?.showNotification,
                d.pairing.showNotification
            ),
            clientDisplayName: str(
                'pairing.client_display_name',
                input.pairing?.clientDisplayName,
                d.pairing.clientDisplayName
            ),
        }),
        send: Object.freeze({
            concurrency: num('send.concurrency', input.send?.concurrency, d.send.concurrency, { min: 1 }),
            minDelayMs: num('send.min_delay_ms', input.send?.minDelayMs, d.send.minDelayMs, { min: 0 }),
            timeoutMs: num('send.timeout_ms', input.send?.timeoutMs, d.send.timeoutMs, { min: 1000 }),
            maxQueue: num('send.max_queue', input.send?.maxQueue, d.send.maxQueue, { min: 1 }),
        }),
        lock: Object.freeze(lock),
        load: Object.freeze({
            concurrency: num('load.concurrency', input.load?.concurrency, d.load.concurrency, { min: 1 }),
            autoStart: bool('load.auto_start', input.load?.autoStart, d.load.autoStart),
        }),
    });
}
