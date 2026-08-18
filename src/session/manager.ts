/**
 * The session registry: which sessions exist in this process, and their lifecycle.
 *
 * Instance-owned, never module-global. v1 kept its sessions map and its config in
 * module scope, so two clients in one process silently shared state -- including
 * their sessions.
 */
import type { AnyMessageContent, MiscMessageGenerationOptions, SocketConfig, WAMessage } from '../compat/baileys.js';
import { assertValidSessionId, type ResolvedConfig } from '../config.js';
import { WhatsMultiError, describeError } from '../errors.js';
import type { WMEventEmitter } from '../events/emitter.js';
import type { EventMap, EventMeta } from '../events/types.js';
import type { Logger } from '../logger.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { mapLimit } from '../utils/concurrency.js';

import { SessionRegistry, type SessionMeta } from './registry.js';
import { Session } from './session.js';
import type { SocketFactory } from './socket-factory.js';

export interface SessionManagerOptions {
    readonly config: ResolvedConfig;
    /** Default backend for sessions created without an override. */
    readonly storage: StorageAdapter;
    readonly emitter: WMEventEmitter;
    readonly logger: Logger;
    readonly socketFactory?: SocketFactory | undefined;
    readonly socketOptions?: Partial<SocketConfig> | undefined;
}

export interface CreateSessionOptions {
    /** Per-session backend. See the note on `discover()` about restoring these. */
    readonly storage?: StorageAdapter | undefined;
    readonly socketOptions?: Partial<SocketConfig> | undefined;
    readonly autoStart?: boolean | undefined;
}

export class SessionManager {
    readonly #config: ResolvedConfig;
    readonly #storage: StorageAdapter;
    readonly #emitter: WMEventEmitter;
    readonly #logger: Logger;
    readonly #socketFactory: SocketFactory | undefined;
    readonly #socketOptions: Partial<SocketConfig> | undefined;
    readonly #registry: SessionRegistry;

    readonly #sessions = new Map<string, Session>();
    /** Every adapter handed to us, so destroy() can close each exactly once. */
    readonly #adapters = new Set<StorageAdapter>();
    #destroyed = false;

    constructor(options: SessionManagerOptions) {
        this.#config = options.config;
        this.#storage = options.storage;
        this.#emitter = options.emitter;
        this.#logger = options.logger.child({ module: 'manager' });
        this.#socketFactory = options.socketFactory;
        this.#socketOptions = options.socketOptions;
        this.#registry = new SessionRegistry(options.storage);
        this.#adapters.add(options.storage);
    }

    get size(): number {
        return this.#sessions.size;
    }

    get destroyed(): boolean {
        return this.#destroyed;
    }

    ids(): string[] {
        return [...this.#sessions.keys()];
    }

    all(): Session[] {
        return [...this.#sessions.values()];
    }

    has(sessionId: string): boolean {
        return this.#sessions.has(sessionId);
    }

    find(sessionId: string): Session | undefined {
        return this.#sessions.get(sessionId);
    }

    /** The session, or SESSION_NOT_FOUND. Use `find` when absence is expected. */
    get(sessionId: string): Session {
        const session = this.#sessions.get(sessionId);
        if (session === undefined) {
            throw new WhatsMultiError('SESSION_NOT_FOUND', { sessionId, params: { sessionId } });
        }
        return session;
    }

    async create(sessionId: string, options: CreateSessionOptions = {}): Promise<Session> {
        this.#assertAlive();
        assertValidSessionId(sessionId);

        if (this.#sessions.has(sessionId)) {
            throw new WhatsMultiError('SESSION_EXISTS', { sessionId, params: { sessionId } });
        }

        const storage = options.storage ?? this.#storage;
        this.#adapters.add(storage);
        await storage.init?.();

        const registry = storage === this.#storage ? this.#registry : new SessionRegistry(storage);
        const existing = await registry.read(sessionId);
        const now = Date.now();
        await registry.write({
            sessionId,
            storage: storage.name,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        });

        const socketOptions = options.socketOptions ?? this.#socketOptions;
        const session = new Session({
            sessionId,
            storage,
            config: this.#config,
            emitter: this.#emitter,
            logger: this.#logger,
            ...(this.#socketFactory === undefined ? {} : { socketFactory: this.#socketFactory }),
            ...(socketOptions === undefined ? {} : { socketOptions }),
        });

        this.#sessions.set(sessionId, session);
        this.#emit(sessionId, 'session.created', { storage: storage.name });

        if (options.autoStart === true) await session.start();
        return session;
    }

    /** Creates the session if it is not already registered, otherwise returns it. */
    async ensure(sessionId: string, options: CreateSessionOptions = {}): Promise<Session> {
        return this.#sessions.get(sessionId) ?? (await this.create(sessionId, options));
    }

    async start(sessionId: string): Promise<void> {
        await this.get(sessionId).start();
    }

    async stop(sessionId: string): Promise<void> {
        await this.get(sessionId).stop();
    }

    async restart(sessionId: string): Promise<void> {
        const session = this.get(sessionId);
        await session.stop();
        await session.start();
    }

    /** Queues a message on one session. Thin by design: the queueing lives there. */
    async send(
        sessionId: string,
        to: string,
        content: AnyMessageContent,
        options?: MiscMessageGenerationOptions
    ): Promise<WAMessage> {
        return this.get(sessionId).send(to, content, options);
    }

    /** Unlinks the device, drops the local data, and deregisters the session. */
    async logout(sessionId: string): Promise<void> {
        const session = this.get(sessionId);
        await session.logout();
        await this.#deregister(sessionId, session, 'logged_out');
    }

    /** Drops the local data and deregisters, leaving the device linked. */
    async remove(sessionId: string): Promise<void> {
        const session = this.get(sessionId);
        await session.remove();
        await this.#deregister(sessionId, session, 'deleted');
    }

    /**
     * Session ids present in the default backend, including ones this process has
     * never opened.
     *
     * Sessions created against an overriding adapter are not listed: rebuilding a
     * Mongo or Redis adapter from a stored name is not possible, so the caller who
     * supplied the adapter re-supplies it.
     */
    async discover(): Promise<string[]> {
        await this.#storage.init?.();
        return this.#registry.list();
    }

    /**
     * Registers every stored session that is not registered yet, with bounded
     * fan-out.
     *
     * v1 used an unbounded `Promise.all` here, so restoring a hundred sessions opened
     * a hundred sockets at once.
     */
    async load(): Promise<Session[]> {
        this.#assertAlive();

        const ids = (await this.discover()).filter((id) => !this.#sessions.has(id));
        return mapLimit(ids, this.#config.load.concurrency, (sessionId) =>
            this.create(sessionId, { autoStart: this.#config.load.autoStart })
        );
    }

    async meta(sessionId: string): Promise<SessionMeta | null> {
        return this.#registry.read(sessionId);
    }

    /**
     * Stops every session and closes every adapter.
     *
     * One failure must not strand the rest, so failures are logged and the shutdown
     * continues. v1 had no shutdown at all, which leaked sockets in tests and in
     * anything serverless.
     */
    async destroy(): Promise<void> {
        if (this.#destroyed) return;
        this.#destroyed = true;

        await mapLimit([...this.#sessions.values()], this.#config.load.concurrency, async (session) => {
            try {
                await session.destroy();
            } catch (cause) {
                this.#logger.warn({ sessionId: session.sessionId, detail: describeError(cause) }, 'destroy failed');
            }
        });
        this.#sessions.clear();

        for (const adapter of this.#adapters) {
            try {
                await adapter.close?.();
            } catch (cause) {
                this.#logger.warn({ adapter: adapter.name, detail: describeError(cause) }, 'adapter close failed');
            }
        }
        this.#adapters.clear();
    }

    #assertAlive(): void {
        if (this.#destroyed) throw new WhatsMultiError('CLIENT_DESTROYED');
    }

    #meta(sessionId: string): EventMeta {
        return { sessionId, instanceId: this.#config.instanceId, ts: Date.now() };
    }

    #emit<K extends 'session.created' | 'session.removed'>(sessionId: string, event: K, data: EventMap[K]): void {
        this.#emitter.emit(event, data, this.#meta(sessionId));
    }

    async #deregister(sessionId: string, session: Session, reason: 'deleted' | 'logged_out'): Promise<void> {
        await new SessionRegistry(session.storage).remove(sessionId);
        this.#sessions.delete(sessionId);
        this.#emit(sessionId, 'session.removed', { reason });
    }
}
