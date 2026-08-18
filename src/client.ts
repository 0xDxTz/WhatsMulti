/**
 * `WhatsMulti` -- the facade the package is imported for.
 *
 * It owns one config, one logger, one event bus, one plugin registry and one session
 * manager, and wires them together. Everything it exposes is a thin delegation, on
 * purpose: the behaviour lives in the layers below, where it can be tested without a
 * client at all.
 *
 * Every piece is instance state. v1 kept its sessions map, its config and its emitter
 * in module scope, so two clients in one process shared all three -- a second client
 * could stop the first one's sessions, and a test could not isolate anything.
 */
import type {
    AnyMessageContent,
    MediaDownloadOptions,
    MiscMessageGenerationOptions,
    SocketConfig,
    WAMessage,
} from './compat/baileys.js';
import { resolveConfig, type ResolvedConfig, type WhatsMultiConfig } from './config.js';
import { WhatsMultiError, describeError } from './errors.js';
import { WMEventEmitter } from './events/emitter.js';
import type { EventBatchListener, EventListener, EventName } from './events/types.js';
import { resolveLogger, type Logger } from './logger.js';
import { PluginRegistry, type Plugin } from './plugin.js';
import { printQr } from './qr/index.js';
import { SessionManager, type CreateSessionOptions } from './session/manager.js';
import type { SessionMeta } from './session/registry.js';
import type { Session } from './session/session.js';
import type { SocketFactory } from './session/socket-factory.js';
import { resolveStorage } from './storage/index.js';
import type { StorageAdapter, StorageInput } from './storage/adapter.js';

export interface WhatsMultiOptions extends WhatsMultiConfig {
    /**
     * Default backend for sessions created without an override. `'memory'` and
     * `'file'` are shorthands; anything else is an adapter instance, which is what
     * keeps mongo, redis and sql out of core.
     *
     * Defaults to `'file'`: credentials that do not survive a restart mean pairing
     * the phone again on every deploy, which is never what someone wanted by
     * accident.
     */
    readonly storage?: StorageInput | undefined;
    /** Merged into every socket. Consumer keys win over ours. */
    readonly socket?: Partial<SocketConfig> | undefined;
    /** Registered before construction returns, so they are set up on first use. */
    readonly plugins?: readonly Plugin[] | undefined;
    readonly maxListeners?: number | undefined;
    /** Replaced in tests by a scripted socket. */
    readonly socketFactory?: SocketFactory | undefined;
}

export class WhatsMulti {
    readonly #config: ResolvedConfig;
    readonly #logger: Logger;
    readonly #emitter: WMEventEmitter;
    readonly #storage: StorageAdapter;
    readonly #plugins = new PluginRegistry();
    readonly #manager: SessionManager;

    /** Set by the first `init()`; awaited by every operation after it. */
    #ready: Promise<void> | undefined;
    #destroyed = false;

    constructor(options: WhatsMultiOptions = {}) {
        this.#config = resolveConfig(options);
        this.#logger = resolveLogger(options.logger, this.#config.logLevel, 'whatsmulti').child({
            instanceId: this.#config.instanceId,
        });
        this.#emitter = new WMEventEmitter({
            logger: this.#logger,
            ...(options.maxListeners === undefined ? {} : { maxListeners: options.maxListeners }),
        });
        this.#storage = resolveStorage(options.storage ?? 'file');
        this.#manager = new SessionManager({
            config: this.#config,
            storage: this.#storage,
            emitter: this.#emitter,
            logger: this.#logger,
            ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
            ...(options.socket === undefined ? {} : { socketOptions: options.socket }),
        });

        for (const plugin of options.plugins ?? []) this.#plugins.register(plugin);
        if (this.#config.qr.print) this.#printEveryQr();
    }

    // ---------------------------------------------------------------- introspection

    get instanceId(): string {
        return this.#config.instanceId;
    }

    /** Frozen at construction. Read it to see what a defaulted value resolved to. */
    get config(): ResolvedConfig {
        return this.#config;
    }

    get logger(): Logger {
        return this.#logger;
    }

    /** The default backend. Sessions created with an override do not use it. */
    get storage(): StorageAdapter {
        return this.#storage;
    }

    /** The bus itself, for anything the delegating methods below do not cover. */
    get events(): WMEventEmitter {
        return this.#emitter;
    }

    /** The manager, for the lifecycle details this facade deliberately flattens. */
    get sessions(): SessionManager {
        return this.#manager;
    }

    /** Sessions registered in this process, not sessions stored. See `discover()`. */
    get size(): number {
        return this.#manager.size;
    }

    get destroyed(): boolean {
        return this.#destroyed;
    }

    ids(): string[] {
        return this.#manager.ids();
    }

    has(sessionId: string): boolean {
        return this.#manager.has(sessionId);
    }

    /** The session, or undefined. Use `session()` when absence is a failure. */
    find(sessionId: string): Session | undefined {
        return this.#manager.find(sessionId);
    }

    /** The session, or SESSION_NOT_FOUND. */
    session(sessionId: string): Session {
        return this.#manager.get(sessionId);
    }

    // --------------------------------------------------------------------- plugins

    /**
     * Registers a plugin. Chainable.
     *
     * Must happen before the first operation: plugins are set up once, and one that
     * arrived afterwards would have missed every event so far without saying so.
     */
    use(plugin: Plugin): this {
        this.#assertAlive();
        this.#plugins.register(plugin);
        return this;
    }

    /**
     * Sets the registered plugins up. Idempotent, and called by every operation
     * below, so it is only worth calling directly when a plugin must be live before
     * the first session exists.
     */
    async init(): Promise<void> {
        this.#assertAlive();
        this.#ready ??= this.#plugins.setup({
            instanceId: this.#config.instanceId,
            config: this.#config,
            logger: this.#logger,
            events: this.#emitter,
        });
        await this.#ready;
    }

    // -------------------------------------------------------------------- sessions

    async createSession(sessionId: string, options?: CreateSessionOptions): Promise<Session> {
        await this.init();
        return this.#manager.create(sessionId, options);
    }

    /** Creates the session, or returns the one already registered. */
    async ensureSession(sessionId: string, options?: CreateSessionOptions): Promise<Session> {
        await this.init();
        return this.#manager.ensure(sessionId, options);
    }

    /**
     * Opens the socket.
     *
     * Resolves once the socket is wired, not once the connection is open: an unpaired
     * session waits in `awaiting_scan` for a scan that may never come. Wait on the
     * `open` event for that.
     */
    async start(sessionId: string): Promise<void> {
        await this.init();
        await this.#manager.start(sessionId);
    }

    /** Closes the socket without unlinking. The session can be started again. */
    async stop(sessionId: string): Promise<void> {
        this.#assertAlive();
        await this.#manager.stop(sessionId);
    }

    async restart(sessionId: string): Promise<void> {
        await this.init();
        await this.#manager.restart(sessionId);
    }

    /**
     * Unlinks the device from the phone, then drops the local data.
     *
     * Distinct from `remove()`, which leaves the device linked. v1 had one call doing
     * both, so asking for local cleanup silently unlinked the phone.
     */
    async logout(sessionId: string): Promise<void> {
        this.#assertAlive();
        await this.#manager.logout(sessionId);
    }

    /** Drops the local data and deregisters. The device stays linked to the phone. */
    async remove(sessionId: string): Promise<void> {
        this.#assertAlive();
        await this.#manager.remove(sessionId);
    }

    /** Session ids in the default backend, including ones never opened here. */
    async discover(): Promise<string[]> {
        await this.init();
        return this.#manager.discover();
    }

    /** Registers every stored session not registered yet, with bounded fan-out. */
    async load(): Promise<Session[]> {
        await this.init();
        return this.#manager.load();
    }

    async meta(sessionId: string): Promise<SessionMeta | null> {
        this.#assertAlive();
        return this.#manager.meta(sessionId);
    }

    // ------------------------------------------------------------------- messaging

    /** Queues a message on one session and resolves with what the driver sent. */
    async send(
        sessionId: string,
        to: string,
        content: AnyMessageContent,
        options?: MiscMessageGenerationOptions
    ): Promise<WAMessage> {
        this.#assertAlive();
        return this.#manager.send(sessionId, to, content, options);
    }

    async downloadMedia(sessionId: string, message: WAMessage, options?: MediaDownloadOptions): Promise<Buffer> {
        this.#assertAlive();
        return this.session(sessionId).downloadMedia(message, options);
    }

    /** The same, as a stream, so a large attachment is never fully held in memory. */
    async downloadMediaStream(
        sessionId: string,
        message: WAMessage,
        options?: MediaDownloadOptions
    ): Promise<ReturnType<Session['downloadMediaStream']>> {
        this.#assertAlive();
        return this.session(sessionId).downloadMediaStream(message, options);
    }

    /**
     * Requests a phone pairing code, formatted `XXXX-XXXX`.
     *
     * The session must be started and have produced at least one QR: the code is
     * bound to that QR reference, which is also why it expires with it.
     */
    async requestPairingCode(sessionId: string, phoneNumber: string): Promise<string> {
        this.#assertAlive();
        return this.session(sessionId).requestPairingCode(phoneNumber);
    }

    // ---------------------------------------------------------------------- events

    on<K extends EventName>(event: K, listener: EventListener<K>): this {
        this.#emitter.on(event, listener);
        return this;
    }

    once<K extends EventName>(event: K, listener: EventListener<K>): this {
        this.#emitter.once(event, listener);
        return this;
    }

    off<K extends EventName>(event: K, listener: EventListener<K>): this {
        this.#emitter.off(event, listener);
        return this;
    }

    /** Catch-all over the driver's buffered batch. Returns an unsubscribe function. */
    process(listener: EventBatchListener): () => void {
        return this.#emitter.process(listener);
    }

    listenerCount(event: EventName): number {
        return this.#emitter.listenerCount(event);
    }

    // -------------------------------------------------------------------- shutdown

    /**
     * Stops every session, closes every adapter, disposes every plugin.
     *
     * Ordered so plugins are still live while the sessions shut down -- a webhook
     * forwarder has to see the final events, and flush them, before it is torn down.
     * Idempotent, and safe to call from a signal handler.
     */
    async destroy(): Promise<void> {
        if (this.#destroyed) return;
        this.#destroyed = true;

        try {
            await this.#manager.destroy();
        } finally {
            try {
                await this.#plugins.dispose(this.#logger);
            } finally {
                this.#emitter.removeAllListeners();
            }
        }
    }

    // ------------------------------------------------------------------- internals

    /**
     * Guards every operation, not only the ones that would fail anyway. `destroy()`
     * clears the session map, so an unguarded call afterwards would report
     * SESSION_NOT_FOUND -- true, but it sends the caller looking for a session that
     * was never the problem.
     */
    #assertAlive(): void {
        if (this.#destroyed) throw new WhatsMultiError('CLIENT_DESTROYED');
    }

    /**
     * `qr.print`. Attached in the constructor rather than per session, because the
     * bus is shared and `meta.sessionId` is what separates them.
     *
     * A failure here is logged, never thrown: the renderer is an optional peer, and
     * not having it installed must not take down a session that is pairing fine.
     */
    #printEveryQr(): void {
        this.#emitter.on('qr', (data, meta) => {
            printQr(data.qr).catch((error: unknown) => {
                this.#logger.warn(
                    { sessionId: meta.sessionId, detail: describeError(error) },
                    'could not print the QR'
                );
            });
        });
    }
}
