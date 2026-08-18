/**
 * A logger interface rather than a logger dependency.
 *
 * v1 hard-wired pino plus pino-pretty into every install, and built the logger at
 * import time -- before any config existed -- so its `LoggerLevel` option never took
 * effect. Here the logger is injected, and the zero-dependency default is only a
 * default.
 *
 * The interface is structurally satisfied by a pino instance, so
 * `new WhatsMulti({ logger: pino() })` needs no adapter.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug', 'trace'];

/** Lower value = more severe. `silent` emits nothing. */
const SEVERITY: Record<LogLevel, number> = {
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
};

export interface LogFn {
    (obj: object, msg?: string): void;
    (msg: string): void;
}

export interface Logger {
    readonly error: LogFn;
    readonly warn: LogFn;
    readonly info: LogFn;
    readonly debug: LogFn;
    readonly trace: LogFn;
    child(bindings: Record<string, unknown>): Logger;
}

/**
 * Whether a message at `level` survives a logger configured at `configured`.
 *
 * Exported because the driver bridge needs the same comparison: a logger handed to
 * Baileys has to filter its own output, and reimplementing the ordering there is how
 * two definitions of `silent` appear in one process.
 */
export function levelEnabled(configured: LogLevel, level: LogLevel): boolean {
    return SEVERITY[level] > 0 && SEVERITY[configured] >= SEVERITY[level];
}

export function isLogLevel(value: unknown): value is LogLevel {
    return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Circular-safe, Error-aware JSON. A logger must never throw on its own payload. */
function serialize(value: Record<string, unknown>): string {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, val: unknown) => {
        if (val instanceof Error) {
            return { ...val, name: val.name, message: val.message, stack: val.stack };
        }
        if (typeof val === 'bigint') return val.toString();
        if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) return '[Circular]';
            seen.add(val);
        }
        return val;
    });
}

export interface ConsoleLoggerOptions {
    readonly level?: LogLevel;
    readonly name?: string;
    /** Defaults to stderr, so log output never contaminates a piped stdout. */
    readonly write?: (line: string) => void;
    readonly bindings?: Record<string, unknown>;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function timestamp(now: Date): string {
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

/**
 * The zero-dependency default. Deliberately plain: no colours, no transport, no
 * worker thread. Anyone who wants those passes pino instead.
 */
export function createLogger(options: ConsoleLoggerOptions = {}): Logger {
    const level = options.level ?? 'info';
    const name = options.name ?? 'whatsmulti';
    const bindings = options.bindings ?? {};
    const write = options.write ?? ((line: string) => process.stderr.write(line));
    const threshold = SEVERITY[level];

    const emit =
        (at: Exclude<LogLevel, 'silent'>): LogFn =>
        (first: object | string, second?: string) => {
            if (SEVERITY[at] > threshold) return;

            const [payload, message] =
                typeof first === 'string'
                    ? [bindings, first]
                    : [{ ...bindings, ...(first as Record<string, unknown>) }, second];

            const context = Object.keys(payload).length > 0 ? ` ${serialize(payload)}` : '';
            write(`${timestamp(new Date())} ${at.toUpperCase().padEnd(5)} [${name}] ${message ?? ''}${context}\n`);
        };

    return {
        error: emit('error'),
        warn: emit('warn'),
        info: emit('info'),
        debug: emit('debug'),
        trace: emit('trace'),
        child(extra) {
            return createLogger({ ...options, level, name, bindings: { ...bindings, ...extra } });
        },
    };
}

const noop: LogFn = () => {};

/** For tests and for `log_level: 'silent'`. Cheaper than filtering on every call. */
export const silentLogger: Logger = {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    child: () => silentLogger,
};

export function resolveLogger(logger: Logger | undefined, level: LogLevel, name?: string): Logger {
    if (logger) return logger;
    if (level === 'silent') return silentLogger;
    return createLogger(name === undefined ? { level } : { level, name });
}
