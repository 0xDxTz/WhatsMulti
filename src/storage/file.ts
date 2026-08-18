import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describeError, WhatsMultiError } from '../errors.js';
import type { StorageAdapter } from './adapter.js';
import { encodeKey, requireStorageKey, sessionPrefix } from './namespace.js';

export const DEFAULT_STORAGE_PATH = './whatsmulti_sessions';

export interface FileStorageOptions {
    readonly path?: string | undefined;
}

/**
 * Filesystem-safe name for one key.
 *
 * The namespace layer only escapes `%`, `:` and `/`, which is enough for a database
 * but not for a filename: Signal key ids carry `+`, `=`, `@` and `*`, and Windows
 * rejects several of those. Everything outside a conservative alphabet is
 * percent-encoded here instead.
 */
const SAFE = /[A-Za-z0-9._-]/;

function fileName(key: string): string {
    let encoded = '';
    for (const byte of Buffer.from(key, 'utf8')) {
        const char = String.fromCharCode(byte);
        encoded += SAFE.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }

    // Filesystems cap a name at 255 bytes and encoding can triple a key's length. A
    // long key falls back to a digest, with the original stored inside the file so
    // keys() can still recover it. Readable names are kept for the common case
    // because being able to `cat` a creds file is worth a branch.
    if (encoded.length <= 200) return `${encoded}.json`;
    return `~${createHash('sha256').update(key).digest('hex')}.json`;
}

function decodeFileName(name: string): string | null {
    if (!name.endsWith('.json')) return null;
    const stem = name.slice(0, -'.json'.length);
    if (stem.startsWith('~')) return null; // digest name; the key lives inside the file

    const bytes: number[] = [];
    for (let i = 0; i < stem.length; i++) {
        if (stem[i] === '%' && i + 2 < stem.length) {
            const parsed = Number.parseInt(stem.slice(i + 1, i + 3), 16);
            if (!Number.isNaN(parsed)) {
                bytes.push(parsed);
                i += 2;
                continue;
            }
        }
        bytes.push(stem.charCodeAt(i));
    }
    return Buffer.from(bytes).toString('utf8');
}

interface Envelope {
    readonly key: string;
    readonly value: unknown;
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

const fail = (detail: string, cause?: unknown) =>
    new WhatsMultiError('STORAGE_ERROR', {
        params: { adapter: 'file', detail },
        ...(cause === undefined ? {} : { cause }),
    });

/**
 * Filesystem backend. One directory per session, one file per key.
 *
 * Writes go to a temporary file and are renamed into place, so a crash mid-write
 * cannot leave truncated credentials behind -- rename is atomic within a filesystem.
 * v1 wrote creds in place.
 */
export function fileStorage(options: FileStorageOptions = {}): StorageAdapter {
    const root = resolve(options.path ?? DEFAULT_STORAGE_PATH);
    let ready: Promise<void> | undefined;

    const ensureRoot = async (): Promise<void> => {
        ready ??= mkdir(root, { recursive: true }).then(() => undefined);
        await ready;
    };

    const pathFor = (key: string) => {
        const { sessionId, key: logical } = requireStorageKey(key);
        return { dir: join(root, sessionId), file: join(root, sessionId, fileName(logical)) };
    };

    const readEnvelope = async (file: string): Promise<Envelope | null> => {
        try {
            return JSON.parse(await readFile(file, 'utf8')) as Envelope;
        } catch (error) {
            if (isMissing(error)) return null;
            throw fail(`cannot read ${file}: ${describeError(error)}`, error);
        }
    };

    const writeEnvelope = async (key: string, value: unknown): Promise<void> => {
        const { dir, file } = pathFor(key);
        const { key: logical } = requireStorageKey(key);
        const body = JSON.stringify({ key: logical, value } satisfies Envelope);

        await mkdir(dir, { recursive: true });
        const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        try {
            await writeFile(temp, body, 'utf8');
            await rename(temp, file);
        } catch (error) {
            await unlink(temp).catch(() => undefined);
            throw fail(`cannot write ${file}: ${describeError(error)}`, error);
        }
    };

    /** Session directories whose namespaced prefix starts with `prefix`. */
    const sessionDirs = async (prefix: string): Promise<string[]> => {
        await ensureRoot();
        let entries;
        try {
            entries = await readdir(root, { withFileTypes: true });
        } catch (error) {
            if (isMissing(error)) return [];
            throw fail(`cannot list ${root}: ${describeError(error)}`, error);
        }

        return (
            entries
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                // Two directions, both legitimate: a namespace-wide prefix covers every
                // session, and a key-level prefix sits inside exactly one session.
                .filter((id) => sessionPrefix(id).startsWith(prefix) || prefix.startsWith(sessionPrefix(id)))
        );
    };

    return {
        name: 'file',

        init: ensureRoot,

        async get<T>(key: string): Promise<T | null> {
            const { file } = pathFor(key);
            const envelope = await readEnvelope(file);
            return envelope === null ? null : (envelope.value as T);
        },

        async mget<T>(keys: string[]): Promise<(T | null)[]> {
            return Promise.all(
                keys.map(async (key) => {
                    const envelope = await readEnvelope(pathFor(key).file);
                    return envelope === null ? null : (envelope.value as T);
                })
            );
        },

        set(key: string, value: unknown): Promise<void> {
            return writeEnvelope(key, value);
        },

        async mset(entries: readonly (readonly [string, unknown])[]): Promise<void> {
            await Promise.all(entries.map(([key, value]) => writeEnvelope(key, value)));
        },

        async del(keys: string[]): Promise<void> {
            await Promise.all(
                keys.map(async (key) => {
                    try {
                        await unlink(pathFor(key).file);
                    } catch (error) {
                        if (!isMissing(error)) throw fail(`cannot delete ${key}: ${describeError(error)}`, error);
                    }
                })
            );
        },

        async keys(prefix: string): Promise<string[]> {
            const found: string[] = [];

            for (const sessionId of await sessionDirs(prefix)) {
                const dir = join(root, sessionId);
                let names: string[];
                try {
                    names = await readdir(dir);
                } catch (error) {
                    if (isMissing(error)) continue;
                    throw fail(`cannot list ${dir}: ${describeError(error)}`, error);
                }

                for (const name of names) {
                    if (name.endsWith('.tmp')) continue;

                    // A digest-named file cannot be decoded, so its key is read back
                    // out of the envelope.
                    const decoded = decodeFileName(name);
                    const logical =
                        decoded ??
                        (name.endsWith('.json') ? ((await readEnvelope(join(dir, name)))?.key ?? null) : null);
                    if (logical === null) continue;

                    const full = sessionPrefix(sessionId) + encodeKey(logical);
                    if (full.startsWith(prefix)) found.push(full);
                }
            }

            return found;
        },

        async clear(prefix: string): Promise<void> {
            for (const sessionId of await sessionDirs(prefix)) {
                const dir = join(root, sessionId);

                // A prefix covering the whole session removes the directory outright;
                // anything narrower has to be filtered key by key.
                if (sessionPrefix(sessionId).startsWith(prefix)) {
                    await rm(dir, { recursive: true, force: true });
                    continue;
                }

                for (const key of await this.keys(prefix)) {
                    await this.del([key]);
                }
            }
        },

        async close(): Promise<void> {
            ready = undefined;
            await Promise.resolve();
        },
    };
}
