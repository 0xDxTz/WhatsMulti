/**
 * SQL storage and locking, over Drizzle.
 *
 * One adapter covers PostgreSQL, MySQL and SQLite. Drizzle is used for what it is
 * uniquely good at here -- compiling one `sql` template into the right placeholder
 * syntax for each dialect -- rather than as a query builder, because the statements
 * this needs are upserts and prefix scans whose portable form is already written down
 * in `spec/storage-schema.sql`.
 *
 * The lock table is the interoperable one: a Go instance and a TypeScript instance
 * pointed at the same database fence each other through it. The auth table is not,
 * and the Go build leaves it empty -- whatsmeow keeps Signal material in its own
 * `sqlstore` tables, and neither runtime can resume the other's paired sessions.
 */
import { sql, type SQL } from 'drizzle-orm';

import { WhatsMultiError, describeError } from '../../errors.js';
import type { LockProvider, LockToken } from '../../lock.js';
import type { StorageAdapter } from '../../storage/adapter.js';
import { NAMESPACE, SEPARATOR, sessionPrefix } from '../../storage/namespace.js';

import { randomBytes } from 'node:crypto';

export type SqlDialect = 'pg' | 'mysql' | 'sqlite';

/**
 * A Drizzle database, structurally.
 *
 * Declared by shape rather than by importing three dialect-specific database types,
 * which would make this module depend on all three driver packages to serve one.
 */
export interface SqlDatabase {
    all?(query: SQL): unknown;
    run?(query: SQL): unknown;
    execute?(query: SQL): unknown;
}

export interface SqlAdapterOptions {
    readonly db: SqlDatabase;
    readonly dialect: SqlDialect;
    /** Defaults to the spec table names. Override to share a database. */
    readonly table?: string | undefined;
    /**
     * Create the table on `init()`. Turn it off when migrations are owned elsewhere;
     * the DDL is in `spec/storage-schema.sql`.
     */
    readonly migrate?: boolean | undefined;
    readonly name?: string | undefined;
}

// -------------------------------------------------------------------- execution

interface Runner {
    all<T>(query: SQL): Promise<T[]>;
    run(query: SQL): Promise<void>;
}

/**
 * Normalises the three shapes a Drizzle result arrives in: an array for SQLite, a
 * `{ rows }` object for node-postgres, and `[rows, fields]` for mysql2.
 */
function rowsOf<T>(result: unknown): T[] {
    if (Array.isArray(result)) {
        const first: unknown = result[0];
        return Array.isArray(first) ? (first as T[]) : (result as T[]);
    }
    if (typeof result === 'object' && result !== null) {
        const rows = (result as { rows?: unknown }).rows;
        if (Array.isArray(rows)) return rows as T[];
    }
    return [];
}

function runnerFor(db: SqlDatabase, dialect: SqlDialect, name: string): Runner {
    const call = (method: 'all' | 'run' | 'execute', query: SQL): unknown => {
        const fn = db[method];
        if (typeof fn !== 'function') {
            throw new WhatsMultiError('STORAGE_ERROR', {
                params: { adapter: name, detail: `the ${dialect} database has no ${method}() method` },
            });
        }
        return fn.call(db, query);
    };

    // SQLite splits reads and writes across all()/run(); pg and mysql funnel both
    // through execute(). better-sqlite3 answers synchronously, hence the await.
    const read = dialect === 'sqlite' ? 'all' : 'execute';
    const write = dialect === 'sqlite' ? 'run' : 'execute';

    return {
        async all<T>(query: SQL): Promise<T[]> {
            return rowsOf<T>(await call(read, query));
        },
        async run(query: SQL): Promise<void> {
            await call(write, query);
        },
    };
}

// ----------------------------------------------------------------------- naming

const AUTH_TABLE = 'whatsmulti_auth';
const LOCK_TABLE = 'whatsmulti_lock';

/**
 * Identifiers cannot be bound as parameters, so a table name is interpolated. Only
 * the characters a SQL identifier is allowed to have are accepted, which is what
 * keeps that from being an injection point.
 */
function identifier(name: string, adapter: string): SQL {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new WhatsMultiError('STORAGE_ERROR', {
            params: { adapter, detail: `"${name}" is not a usable table name` },
        });
    }
    return sql.raw(name);
}

/** `%`, `_` and the escape itself, so a percent-encoded key cannot act as a wildcard. */
function likePrefix(prefix: string): string {
    return `${prefix.replace(/([\\%_])/g, '\\$1')}%`;
}

/**
 * The LIKE escape character, spelled for each engine.
 *
 * MySQL treats a backslash as an escape inside string literals and PostgreSQL (with
 * standard_conforming_strings, the default since 9.1) does not, so the same backslash
 * has to be written twice for one and once for the other.
 */
function escapeClause(dialect: SqlDialect): SQL {
    return sql.raw(dialect === 'mysql' ? "ESCAPE '\\\\'" : "ESCAPE '\\'");
}

interface KeyScope {
    /** Absent means every session. */
    readonly sessionId?: string | undefined;
    /** A LIKE pattern on session_id, for a prefix that stops mid-id. */
    readonly sessionPrefix?: string | undefined;
    readonly keyPrefix?: string | undefined;
    /** Nothing under this prefix can exist. */
    readonly empty?: boolean | undefined;
}

/**
 * Turns a storage prefix into a predicate over the split columns.
 *
 * The rows keep `session_id` and `auth_key` apart, as `spec/storage-schema.sql` has
 * them, so a prefix spanning the separator has to be taken apart the same way.
 */
function scopeOf(prefix: string): KeyScope {
    const root = `${NAMESPACE}${SEPARATOR}`;
    if (root.startsWith(prefix)) return {};
    if (!prefix.startsWith(root)) return { empty: true };

    const rest = prefix.slice(root.length);
    const separator = rest.indexOf(SEPARATOR);
    if (separator === -1) return { sessionPrefix: rest };

    return { sessionId: rest.slice(0, separator), keyPrefix: rest.slice(separator + 1) };
}

function scopeWhere(scope: KeyScope, dialect: SqlDialect): SQL {
    const escape = escapeClause(dialect);
    const clauses: SQL[] = [];

    if (scope.sessionId !== undefined) clauses.push(sql`session_id = ${scope.sessionId}`);
    if (scope.sessionPrefix !== undefined && scope.sessionPrefix.length > 0) {
        clauses.push(sql`session_id LIKE ${likePrefix(scope.sessionPrefix)} ${escape}`);
    }
    if (scope.keyPrefix !== undefined && scope.keyPrefix.length > 0) {
        clauses.push(sql`auth_key LIKE ${likePrefix(scope.keyPrefix)} ${escape}`);
    }

    if (clauses.length === 0) return sql`1 = 1`;
    return sql.join(clauses, sql` AND `);
}

/** Splits a full storage key into the two columns. Foreign keys are skipped. */
function split(full: string): { sessionId: string; authKey: string } | null {
    const root = `${NAMESPACE}${SEPARATOR}`;
    if (!full.startsWith(root)) return null;

    const rest = full.slice(root.length);
    const separator = rest.indexOf(SEPARATOR);
    if (separator <= 0) return null;

    // The tail stays percent-encoded: `spec/algorithms.md` section 3 defines
    // `auth_key` as the encoded form, and storing it verbatim makes rebuilding the
    // full key exact rather than a re-encode that has to agree.
    return { sessionId: rest.slice(0, separator), authKey: rest.slice(separator + 1) };
}

const joinKey = (sessionId: string, authKey: string): string => sessionPrefix(sessionId) + authKey;

// ---------------------------------------------------------------------- storage

interface AuthRow {
    session_id: string;
    auth_key: string;
    value: string;
}

/**
 * The DDL, per engine.
 *
 * `spec/storage-schema.sql` is written in portable SQL and calls the value column
 * BLOB; the concrete types below are that spec mapped onto each engine. Values are
 * JSON text, because encoding happens in `auth/codec.ts` and reaches the adapter
 * already serialisable.
 */
function authDdl(dialect: SqlDialect, table: SQL): SQL {
    if (dialect === 'sqlite') {
        return sql`CREATE TABLE IF NOT EXISTS ${table} (
            session_id TEXT NOT NULL,
            auth_key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, auth_key)
        )`;
    }
    const text = dialect === 'mysql' ? sql.raw('LONGTEXT') : sql.raw('TEXT');
    return sql`CREATE TABLE IF NOT EXISTS ${table} (
        session_id VARCHAR(64) NOT NULL,
        auth_key VARCHAR(512) NOT NULL,
        value ${text} NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (session_id, auth_key)
    )`;
}

export function sqlStorage(options: SqlAdapterOptions): StorageAdapter {
    const name = options.name ?? 'sql';
    const table = identifier(options.table ?? AUTH_TABLE, name);
    const runner = runnerFor(options.db, options.dialect, name);
    const migrate = options.migrate ?? true;
    let ready: Promise<void> | undefined;

    const guard = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
        try {
            return await run();
        } catch (cause) {
            throw new WhatsMultiError('STORAGE_ERROR', {
                params: { adapter: name, detail: `${operation}: ${describeError(cause)}` },
                cause,
            });
        }
    };

    const upsert = (rows: { sessionId: string; authKey: string; value: string }[], now: number): SQL => {
        const values = sql.join(
            rows.map((row) => sql`(${row.sessionId}, ${row.authKey}, ${row.value}, ${now})`),
            sql`, `
        );

        // MySQL has no ON CONFLICT; the other two have no VALUES() in an update. Same
        // statement otherwise, which is why the tail is the only thing that branches.
        const tail =
            options.dialect === 'mysql'
                ? sql.raw('ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)')
                : sql.raw(
                      'ON CONFLICT (session_id, auth_key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at'
                  );

        return sql`INSERT INTO ${table} (session_id, auth_key, value, updated_at) VALUES ${values} ${tail}`;
    };

    const write = async (entries: readonly (readonly [string, unknown])[]): Promise<void> => {
        const rows = entries
            .map(([key, value]) => {
                const parts = split(key);
                return parts === null ? null : { ...parts, value: JSON.stringify(value ?? null) };
            })
            .filter((row) => row !== null);
        if (rows.length === 0) return;

        const now = Date.now();
        // Chunked: one statement per few hundred rows keeps a session resume to a
        // couple of round trips without hitting a placeholder limit.
        for (let i = 0; i < rows.length; i += 200) {
            await runner.run(upsert(rows.slice(i, i + 200), now));
        }
    };

    const parse = <T>(value: string | undefined): T | null => (value === undefined ? null : (JSON.parse(value) as T));

    return {
        name,

        async init() {
            if (!migrate) return;
            ready ??= guard('init', () => runner.run(authDdl(options.dialect, table)));
            await ready;
        },

        async get<T>(key: string) {
            const [row] = await this.mget<T>([key]);
            return row ?? null;
        },

        async mget<T>(keys: string[]) {
            if (keys.length === 0) return [];

            const parts = keys.map(split);
            const wanted = parts.filter((part) => part !== null);
            if (wanted.length === 0) return keys.map(() => null);

            const rows = await guard('mget', () =>
                runner.all<AuthRow>(
                    sql`SELECT session_id, auth_key, value FROM ${table} WHERE ${sql.join(
                        wanted.map((part) => sql`(session_id = ${part.sessionId} AND auth_key = ${part.authKey})`),
                        sql` OR `
                    )}`
                )
            );

            // Indexed by key so duplicates in the request each get an answer, which a
            // positional zip of the result set would not give.
            const found = new Map(rows.map((row) => [joinKey(row.session_id, row.auth_key), row.value]));
            return keys.map((key) => parse<T>(found.get(key)));
        },

        async set(key: string, value: unknown) {
            await guard('set', () => write([[key, value]]));
        },

        async mset(entries) {
            await guard('mset', () => write(entries));
        },

        async del(keys: string[]) {
            const parts = keys.map(split).filter((part) => part !== null);
            if (parts.length === 0) return;

            await guard('del', () =>
                runner.run(
                    sql`DELETE FROM ${table} WHERE ${sql.join(
                        parts.map((part) => sql`(session_id = ${part.sessionId} AND auth_key = ${part.authKey})`),
                        sql` OR `
                    )}`
                )
            );
        },

        async keys(prefix: string) {
            const scope = scopeOf(prefix);
            if (scope.empty === true) return [];

            const rows = await guard('keys', () =>
                runner.all<Pick<AuthRow, 'session_id' | 'auth_key'>>(
                    sql`SELECT session_id, auth_key FROM ${table} WHERE ${scopeWhere(scope, options.dialect)}`
                )
            );

            return rows.map((row) => joinKey(row.session_id, row.auth_key));
        },

        async clear(prefix: string) {
            const scope = scopeOf(prefix);
            if (scope.empty === true) return;

            await guard('clear', () =>
                runner.run(sql`DELETE FROM ${table} WHERE ${scopeWhere(scope, options.dialect)}`)
            );
        },
    };
}

// ------------------------------------------------------------------------- lock

interface LockRow {
    lock_key: string;
    token: string;
    owner: string;
    expires_at: number | string;
}

function lockDdl(dialect: SqlDialect, table: SQL): SQL {
    if (dialect === 'sqlite') {
        return sql`CREATE TABLE IF NOT EXISTS ${table} (
            lock_key TEXT NOT NULL PRIMARY KEY,
            token TEXT NOT NULL,
            owner TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        )`;
    }
    return sql`CREATE TABLE IF NOT EXISTS ${table} (
        lock_key VARCHAR(128) NOT NULL,
        token VARCHAR(64) NOT NULL,
        owner VARCHAR(128) NOT NULL,
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (lock_key)
    )`;
}

export interface SqlLockOptions extends Omit<SqlAdapterOptions, 'table'> {
    readonly table?: string | undefined;
}

/**
 * The interoperable half.
 *
 * `spec/storage-schema.sql` sketches the acquire as a conditional upsert, which
 * PostgreSQL and SQLite express with `ON CONFLICT ... WHERE` and MySQL cannot express
 * at all. This does the same thing in two portable statements instead: sweep the row
 * if its lease has lapsed, then insert. The insert is the atomic gate -- when two
 * instances both sweep an expired lock, exactly one insert survives the primary key.
 */
export function sqlLock(options: SqlLockOptions): LockProvider {
    const name = options.name ?? 'sql';
    const table = identifier(options.table ?? LOCK_TABLE, name);
    const runner = runnerFor(options.db, options.dialect, name);
    const migrate = options.migrate ?? true;
    let ready: Promise<void> | undefined;

    const init = async (): Promise<void> => {
        if (!migrate) return;
        ready ??= runner.run(lockDdl(options.dialect, table));
        await ready;
    };

    const read = async (key: string): Promise<LockRow | null> => {
        const [row] = await runner.all<LockRow>(sql`SELECT * FROM ${table} WHERE lock_key = ${key}`);
        return row ?? null;
    };

    const toToken = (row: LockRow): LockToken => ({
        key: row.lock_key,
        token: row.token,
        owner: row.owner,
        // BIGINT comes back as a string from some drivers, which would make every
        // comparison a lexicographic one.
        expiresAt: Number(row.expires_at),
    });

    /** Held iff `expires_at >= now`, the boundary spec/storage-schema.sql uses. */
    const live = (row: LockRow | null, now: number): LockToken | null => {
        if (row === null) return null;
        const token = toToken(row);
        return token.expiresAt >= now ? token : null;
    };

    return {
        name,

        async acquire(key, ttlMs, owner) {
            await init();
            const now = Date.now();

            await runner.run(sql`DELETE FROM ${table} WHERE lock_key = ${key} AND expires_at < ${now}`);

            const held: LockToken = { key, token: randomBytes(16).toString('hex'), owner, expiresAt: now + ttlMs };
            try {
                await runner.run(
                    sql`INSERT INTO ${table} (lock_key, token, owner, expires_at)
                        VALUES (${held.key}, ${held.token}, ${held.owner}, ${held.expiresAt})`
                );
            } catch (cause) {
                // A live row means the insert lost the race, which is the normal
                // refusal. Anything else is a real failure and must not be reported
                // as "someone else holds it".
                if (live(await read(key), Date.now()) !== null) return null;
                throw new WhatsMultiError('STORAGE_ERROR', {
                    params: { adapter: name, detail: `acquire: ${describeError(cause)}` },
                    cause,
                });
            }
            return held;
        },

        async renew(token, ttlMs) {
            await init();
            const now = Date.now();
            const expiresAt = now + ttlMs;

            await runner.run(
                sql`UPDATE ${table} SET expires_at = ${expiresAt}
                    WHERE lock_key = ${token.key} AND token = ${token.token} AND expires_at >= ${now}`
            );

            // Re-read rather than trusting a driver-specific "rows affected" number,
            // which mysql2 reports as 0 for an update that changed nothing.
            const current = live(await read(token.key), now);
            return current?.token === token.token ? current : null;
        },

        async release(token) {
            await init();
            await runner.run(sql`DELETE FROM ${table} WHERE lock_key = ${token.key} AND token = ${token.token}`);
        },

        async inspect(key) {
            await init();
            return live(await read(key), Date.now());
        },
    };
}
