import { RELEASE_SCRIPT, RENEW_SCRIPT, type RedisClient } from '../../src/adapters/redis/index.js';

/**
 * An in-memory stand-in for a Redis client.
 *
 * It implements the commands the adapter issues -- GET, MGET, SET with PX/NX, MSET,
 * DEL, SCAN with MATCH and COUNT, PTTL -- with Redis's own semantics, including lazy
 * expiry and a paging cursor, so the adapter's logic is exercised for real without a
 * server.
 *
 * The exception is EVAL. The two Lua scripts are recognised by identity and their
 * documented effect is applied here; the Lua itself only runs against a real server.
 * Set REDIS_URL to run the same suites against one.
 */
interface Entry {
    value: string;
    expiresAt: number | undefined;
}

export class FakeRedis implements RedisClient {
    readonly #store = new Map<string, Entry>();
    closed = false;
    /** Every command issued, for asserting what the adapter actually sent. */
    readonly commands: string[] = [];
    /** Set to make the next command reject. */
    failWith: Error | undefined;

    get size(): number {
        this.#sweep();
        return this.#store.size;
    }

    async call(command: string, ...args: (string | number)[]): Promise<unknown> {
        if (this.failWith !== undefined) throw this.failWith;
        this.commands.push(command);

        const text = args.map((arg) => String(arg));
        switch (command.toUpperCase()) {
            case 'GET':
                return this.#get(text[0]!);
            case 'MGET':
                return text.map((key) => this.#get(key));
            case 'SET':
                return this.#set(text);
            case 'MSET':
                return this.#mset(text);
            case 'DEL':
                return this.#del(text);
            case 'SCAN':
                return this.#scan(text);
            case 'PTTL':
                return this.#pttl(text[0]!);
            case 'EVAL':
                return this.#eval(text);
            default:
                throw new Error(`FakeRedis does not implement ${command}`);
        }
    }

    quit(): Promise<unknown> {
        this.closed = true;
        return Promise.resolve('OK');
    }

    // ----------------------------------------------------------------- internals

    #sweep(): void {
        const now = Date.now();
        for (const [key, entry] of this.#store) {
            if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.#store.delete(key);
        }
    }

    #get(key: string): string | null {
        this.#sweep();
        return this.#store.get(key)?.value ?? null;
    }

    #set(args: string[]): string | null {
        const [key, value, ...rest] = args;
        this.#sweep();

        const nx = rest.some((arg) => arg.toUpperCase() === 'NX');
        if (nx && this.#store.has(key!)) return null;

        const pxAt = rest.findIndex((arg) => arg.toUpperCase() === 'PX');
        const ttl = pxAt === -1 ? undefined : Number(rest[pxAt + 1]);

        this.#store.set(key!, { value: value!, expiresAt: ttl === undefined ? undefined : Date.now() + ttl });
        return 'OK';
    }

    #mset(args: string[]): string {
        for (let i = 0; i + 1 < args.length; i += 2) {
            this.#store.set(args[i]!, { value: args[i + 1]!, expiresAt: undefined });
        }
        return 'OK';
    }

    #del(keys: string[]): number {
        let removed = 0;
        for (const key of keys) if (this.#store.delete(key)) removed += 1;
        return removed;
    }

    #pttl(key: string): number {
        this.#sweep();
        const entry = this.#store.get(key);
        if (entry === undefined) return -2;
        if (entry.expiresAt === undefined) return -1;
        return entry.expiresAt - Date.now();
    }

    /** Cursor is an index into a snapshot, which is enough to exercise the paging. */
    #scan(args: string[]): [string, string[]] {
        this.#sweep();

        const cursor = Number(args[0] ?? '0');
        const matchAt = args.findIndex((arg) => arg.toUpperCase() === 'MATCH');
        const countAt = args.findIndex((arg) => arg.toUpperCase() === 'COUNT');
        const pattern = matchAt === -1 ? '*' : (args[matchAt + 1] ?? '*');
        const count = countAt === -1 ? 10 : Number(args[countAt + 1]);

        const all = [...this.#store.keys()];
        const page = all.slice(cursor, cursor + count);
        const next = cursor + count >= all.length ? '0' : String(cursor + count);

        return [next, page.filter((key) => globToRegExp(pattern).test(key))];
    }

    #eval(args: string[]): number {
        const [script, , key, token, ttl] = args;
        this.#sweep();

        const entry = this.#store.get(key!);
        if (entry === undefined) return 0;
        if ((JSON.parse(entry.value) as { token?: string }).token !== token) return 0;

        if (script === RENEW_SCRIPT) {
            entry.expiresAt = Date.now() + Number(ttl);
            return 1;
        }
        if (script === RELEASE_SCRIPT) {
            this.#store.delete(key!);
            return 1;
        }
        throw new Error('FakeRedis only knows the adapter’s own scripts');
    }
}

/** Redis glob, including its backslash escape, as a regular expression. */
function globToRegExp(pattern: string): RegExp {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i]!;
        if (char === '\\' && i + 1 < pattern.length) {
            out += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            continue;
        }
        if (char === '*') out += '.*';
        else if (char === '?') out += '.';
        else out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
}
