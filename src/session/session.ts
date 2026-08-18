/**
 * One session: one socket, one auth state, one state machine.
 *
 * Everything that decides *what* to do lives in state.ts, disconnect.ts and
 * reconnect.ts, which are pure and shared with the Go build. This file only wires
 * those decisions to a driver socket and to the event bus, which is why it can be
 * tested end to end against a scripted stand-in with no network.
 *
 * Nothing here is module-global. v1 kept its sessions and config in module scope, so
 * two clients in one process silently shared state.
 */
import type { AuthStateHandle } from '../auth/index.js';
import { useAuthState } from '../auth/index.js';
import type {
    AnyMessageContent,
    MediaDownloadOptions,
    MiscMessageGenerationOptions,
    SocketConfig,
    WAMessage,
    WASocket,
} from '../compat/baileys.js';
import type { ResolvedConfig } from '../config.js';
import { WhatsMultiError, describeError, wrapError } from '../errors.js';
import type { WMEventEmitter } from '../events/emitter.js';
import type { EventBatch, EventMap, EventMeta, EventName } from '../events/types.js';
import type { SessionState } from '../generated/index.js';
import { sessionLockKey, type LockProvider, type LockToken } from '../lock.js';
import type { Logger } from '../logger.js';
import { normalizePhoneNumber } from '../messaging/jid.js';
import { downloadMedia, downloadMediaStream, type DownloadRequest } from '../messaging/media.js';
import { SendQueue } from '../messaging/queue.js';
import { sendMessage } from '../messaging/send.js';
import type { StorageAdapter } from '../storage/adapter.js';

import { decideDisconnect, disconnectTrigger } from './disconnect.js';
import { ReconnectPolicy } from './reconnect.js';
import { createSocket, type SocketFactory } from './socket-factory.js';
import { SessionMachine } from './state.js';

export interface SessionOptions {
    readonly sessionId: string;
    readonly storage: StorageAdapter;
    readonly config: ResolvedConfig;
    /** Shared with every other session; `meta.sessionId` is what separates them. */
    readonly emitter: WMEventEmitter;
    readonly logger: Logger;
    /**
     * Shared with every other session on the same client. Omit to run unfenced,
     * which is only safe when nothing else can open this session.
     */
    readonly lockProvider?: LockProvider | undefined;
    /** Replaced in tests by a scripted socket. */
    readonly socketFactory?: SocketFactory | undefined;
    readonly socketOptions?: Partial<SocketConfig> | undefined;
    /** Seeded jitter source, for reproducible reconnect delays. */
    readonly random?: (() => number) | undefined;
}

/** Formats what the driver returns as the `XXXX-XXXX` the user is shown. */
export function formatPairingCode(raw: string): string {
    return raw.length === 8 && !raw.includes('-') ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export class Session {
    readonly sessionId: string;
    readonly storage: StorageAdapter;

    readonly #config: ResolvedConfig;
    readonly #emitter: WMEventEmitter;
    readonly #logger: Logger;
    readonly #machine: SessionMachine;
    readonly #policy: ReconnectPolicy;
    #queue: SendQueue;
    readonly #factory: SocketFactory;
    readonly #socketOptions: Partial<SocketConfig> | undefined;
    readonly #lockProvider: LockProvider | undefined;

    #auth: AuthStateHandle | undefined;
    #socket: WASocket | undefined;
    #detach: (() => void) | undefined;
    #timer: ReturnType<typeof setTimeout> | undefined;
    #held: LockToken | undefined;
    #heartbeat: ReturnType<typeof setTimeout> | undefined;

    /** Set by stop, destroy and QR exhaustion: a close we asked for must not retry. */
    #suppressReconnect = false;
    #destroyed = false;
    #qrAttempt = 0;
    #sawQr = false;
    #pairingPending = false;

    constructor(options: SessionOptions) {
        this.sessionId = options.sessionId;
        this.storage = options.storage;
        this.#config = options.config;
        this.#emitter = options.emitter;
        this.#logger = options.logger.child({ module: 'session', sessionId: options.sessionId });
        this.#factory = options.socketFactory ?? createSocket;
        this.#socketOptions = options.socketOptions;
        this.#lockProvider = options.lockProvider;
        this.#policy = new ReconnectPolicy({ config: options.config.reconnect, random: options.random });
        this.#queue = this.#newQueue();
        this.#machine = new SessionMachine({
            sessionId: options.sessionId,
            onTransition: ({ from, to, trigger }) => {
                this.#logger.debug({ from, to, trigger }, 'state');
                this.#emit('session.state', { from, to, reason: trigger });
            },
        });
    }

    get state(): SessionState {
        return this.#machine.state;
    }

    get socket(): WASocket | undefined {
        return this.#socket;
    }

    /** True only while `open`. Guarded before every send. */
    get sendable(): boolean {
        return this.#machine.sendable;
    }

    /** QR codes issued since the last successful open. */
    get qrAttempt(): number {
        return this.#qrAttempt;
    }

    get reconnectAttempt(): number {
        return this.#policy.attempt;
    }

    /**
     * Sends waiting for a slot. The backpressure signal: a number that keeps climbing
     * means the caller is producing faster than the rate limit allows.
     */
    get queueSize(): number {
        return this.#queue.size;
    }

    get destroyed(): boolean {
        return this.#destroyed;
    }

    /** The lock this session holds, if it holds one. Undefined while stopped. */
    get lock(): LockToken | undefined {
        return this.#held;
    }

    // ------------------------------------------------------------------- lifecycle

    /**
     * Opens the socket.
     *
     * Resolves once the socket exists and is wired, **not** once the connection is
     * open: an unpaired session sits in `awaiting_scan` until someone scans, which
     * could be never. Wait on the `open` or `qr` event for that.
     */
    async start(): Promise<void> {
        this.#assertAlive();
        this.#machine.apply('start');
        // A stopped session closed its queue; starting again needs an open one.
        if (this.#queue.closed) this.#queue = this.#newQueue();

        try {
            // Before the socket, never after: a socket opened while another instance
            // holds the session has already begun writing the Signal key store.
            await this.#acquireLock();
            await this.#openSocket();
        } catch (error) {
            this.#machine.tryApply('disconnected');
            throw error;
        }
    }

    /** Closes the socket without unlinking. The session can be started again. */
    async stop(): Promise<void> {
        this.#suppressReconnect = true;
        this.#clearTimer();
        this.#machine.tryApply('stop');

        // Closed before the socket goes away so nothing new is accepted, then drained
        // so a send already on the wire is allowed to finish rather than being cut
        // off mid-flight.
        this.#queue.close();
        await this.#queue.drain();

        await this.#closeSocket();
        // Released after the socket is down, so nothing of ours is still on the wire
        // when another instance is told it may start.
        await this.#releaseLock();
        this.#machine.tryApply('stopped');
    }

    /**
     * Unlinks the device from the phone, then deletes the local auth state.
     *
     * If the unlink fails the credentials are deliberately kept and the call throws:
     * purging them would leave a device linked to the phone that can never be
     * unlinked again, because the credentials needed to try are gone.
     */
    async logout(): Promise<void> {
        this.#assertAlive();

        const socket = this.#requireOpen();

        this.#suppressReconnect = true;
        this.#clearTimer();
        // Detached first: we own the outcome from here, and letting the driver's own
        // close event run the disconnect path too would emit everything twice.
        this.#detachEvents();

        try {
            await socket.logout();
        } catch (cause) {
            this.#suppressReconnect = false;
            throw wrapError('LOGOUT_FAILED', cause, {
                sessionId: this.sessionId,
                params: { sessionId: this.sessionId, detail: describeError(cause) },
            });
        }

        await this.#closeSocket();
        await this.#releaseLock();
        this.#machine.tryApply('logged_out');
        await this.#purgeAuth();
        this.#emit('session.logged_out', { cause: 'logged_out' });
    }

    /**
     * Stops the session and deletes its local data, leaving the device linked.
     *
     * v1 had no such separation: deleteSession called logout(), so asking for local
     * cleanup silently unlinked the device (plan defect 17).
     */
    async remove(): Promise<void> {
        await this.stop();
        await this.#purgeAuth();
    }

    /** Leaves `logged_out`, so the session can be paired again. */
    reset(): void {
        this.#assertAlive();
        this.#machine.apply('reset');
        this.#qrAttempt = 0;
        this.#sawQr = false;
        this.#policy.reset();
    }

    async destroy(): Promise<void> {
        if (this.#destroyed) return;
        this.#destroyed = true;
        await this.stop();
    }

    // -------------------------------------------------------------------- messaging

    /**
     * Queues a message and resolves with what the driver sent.
     *
     * Sends run one at a time by default: two in flight at once mutate the same
     * Signal session state concurrently, and the loser of that race produces a
     * message the recipient cannot decrypt.
     *
     * The queue smooths bursts; it does not buffer across a disconnect. A session
     * that is not open refuses immediately rather than collecting sends that would
     * fail later anyway.
     */
    async send(to: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions): Promise<WAMessage> {
        this.#assertAlive();
        this.#requireOpen();

        return this.#queue.push(() => {
            // Re-checked here, not only on the way in: the session can drop while this
            // task waits behind others in the queue.
            const socket = this.#requireOpen();
            return sendMessage({
                sessionId: this.sessionId,
                socket,
                to,
                content,
                timeoutMs: this.#config.send.timeoutMs,
                ...(options === undefined ? {} : { options }),
            });
        });
    }

    /** Downloads an attachment. Not queued: reads do not contend for Signal state. */
    async downloadMedia(message: WAMessage, options?: MediaDownloadOptions): Promise<Buffer> {
        this.#assertAlive();
        return downloadMedia(this.#downloadRequest(message, options));
    }

    /** The same, as a stream, so a large attachment is never held in memory at once. */
    async downloadMediaStream(
        message: WAMessage,
        options?: MediaDownloadOptions
    ): Promise<ReturnType<typeof downloadMediaStream>> {
        this.#assertAlive();
        return downloadMediaStream(this.#downloadRequest(message, options));
    }

    #downloadRequest(message: WAMessage, options?: MediaDownloadOptions): DownloadRequest {
        return {
            sessionId: this.sessionId,
            message,
            logger: this.#logger,
            // Passed whenever we have one, so an expired media URL can be refreshed.
            ...(this.#socket === undefined ? {} : { socket: this.#socket }),
            ...(options === undefined ? {} : { options }),
        };
    }

    // --------------------------------------------------------------------- pairing

    /**
     * Requests a phone pairing code.
     *
     * The preconditions match whatsmeow's PairPhone exactly (plan section 4.5): the
     * socket must be up and have produced at least one QR -- the code is bound to
     * that QR reference, which is also why it expires with it -- and only one request
     * may be pending, because a second silently invalidates the first.
     */
    async requestPairingCode(phoneNumber: string): Promise<string> {
        this.#assertAlive();

        const socket = this.#socket;
        if (socket === undefined || !this.#machine.pairable || !this.#sawQr) {
            throw new WhatsMultiError('PAIRING_UNAVAILABLE', {
                sessionId: this.sessionId,
                params: { sessionId: this.sessionId, state: this.#machine.state },
            });
        }

        if (this.#pairingPending) {
            throw new WhatsMultiError('PAIRING_IN_PROGRESS', {
                sessionId: this.sessionId,
                params: { sessionId: this.sessionId },
            });
        }

        const digits = normalizePhoneNumber(phoneNumber);
        this.#pairingPending = true;

        let raw: string;
        try {
            raw = await socket.requestPairingCode(digits);
        } catch (cause) {
            this.#pairingPending = false;
            throw wrapError('PAIRING_UNAVAILABLE', cause, {
                sessionId: this.sessionId,
                params: { sessionId: this.sessionId, state: this.#machine.state },
            });
        }

        const code = formatPairingCode(raw);
        this.#emit('pairing.code', {
            code,
            phoneNumber: digits,
            expiresAt: Date.now() + this.#config.qr.timeoutMs,
        });
        return code;
    }

    // ------------------------------------------------------------------- internals

    #newQueue(): SendQueue {
        return new SendQueue({ sessionId: this.sessionId, config: this.#config.send });
    }

    /** The socket, or SESSION_NOT_READY naming the state that refused. */
    #requireOpen(): WASocket {
        const socket = this.#socket;
        if (socket === undefined || !this.#machine.sendable) {
            throw new WhatsMultiError('SESSION_NOT_READY', {
                sessionId: this.sessionId,
                params: { sessionId: this.sessionId, state: this.#machine.state, expected: 'open' },
            });
        }
        return socket;
    }

    #assertAlive(): void {
        if (this.#destroyed) throw new WhatsMultiError('CLIENT_DESTROYED', { sessionId: this.sessionId });
    }

    #meta(): EventMeta {
        return {
            sessionId: this.sessionId,
            instanceId: this.#config.instanceId,
            ts: Date.now(),
            socket: this.#socket,
        };
    }

    #emit<K extends EventName>(event: K, data: EventMap[K]): void {
        this.#emitter.emit(event, data, this.#meta());
    }

    /**
     * Routes a failure to `session.error`.
     *
     * One of our own errors keeps its code; anything foreign becomes SESSION_FAILED
     * rather than borrowing whichever specific code happens to be nearby, which would
     * make consumers branch on a code that does not describe what went wrong.
     */
    #reportError(error: unknown, context: string): void {
        const wrapped = wrapError('SESSION_FAILED', error, {
            sessionId: this.sessionId,
            params: { sessionId: this.sessionId, detail: describeError(error) },
        });
        this.#logger.error({ err: error, context }, 'session failure');
        this.#emit('session.error', { code: wrapped.code, message: wrapped.message });
    }

    async #ensureAuth(): Promise<AuthStateHandle> {
        this.#auth ??= await useAuthState({
            sessionId: this.sessionId,
            storage: this.storage,
            logger: this.#logger,
        });
        return this.#auth;
    }

    async #purgeAuth(): Promise<void> {
        const auth = await this.#ensureAuth();
        await auth.purge();
        // Dropped so the next start regenerates credentials instead of reusing the
        // in-memory copy of the ones just deleted.
        this.#auth = undefined;
    }

    async #openSocket(): Promise<void> {
        this.#suppressReconnect = false;
        const auth = await this.#ensureAuth();

        const socket = await this.#factory({
            sessionId: this.sessionId,
            auth: auth.state,
            config: this.#config,
            logger: this.#logger,
            ...(this.#socketOptions === undefined ? {} : { socketOptions: this.#socketOptions }),
        });

        this.#socket = socket;
        this.#detach = socket.ev.process((events) => this.#onEvents(events as EventBatch));
    }

    #detachEvents(): void {
        this.#detach?.();
        this.#detach = undefined;
    }

    async #closeSocket(): Promise<void> {
        const socket = this.#socket;
        this.#detachEvents();
        this.#socket = undefined;
        if (socket === undefined) return;

        try {
            await socket.end(undefined);
        } catch (cause) {
            // A socket that is already gone is the normal case here, not a failure.
            this.#logger.debug({ err: cause }, 'socket end failed');
        }
    }

    #clearTimer(): void {
        if (this.#timer !== undefined) clearTimeout(this.#timer);
        this.#timer = undefined;
    }

    // ------------------------------------------------------------------- fencing

    /**
     * Takes the session lock, or refuses to start.
     *
     * Held across reconnects rather than re-taken per socket: dropping it during a
     * backoff would invite another instance in during exactly the window where this
     * one still intends to come back.
     */
    async #acquireLock(): Promise<void> {
        const lock = this.#lockProvider;
        if (lock === undefined || !this.#config.lock.enabled || this.#held !== undefined) return;

        const key = sessionLockKey(this.sessionId);
        const held = await lock.acquire(key, this.#config.lock.ttlMs, this.#config.instanceId);

        if (held === null) {
            throw new WhatsMultiError('SESSION_LOCKED', {
                sessionId: this.sessionId,
                params: { sessionId: this.sessionId, owner: await this.#ownerOf(key) },
            });
        }

        this.#held = held;
        this.#scheduleRenew();
    }

    /** Who holds the lock, for an error message. Never throws: this is reporting. */
    async #ownerOf(key: string): Promise<string> {
        try {
            return (await this.#lockProvider?.inspect(key))?.owner ?? 'another instance';
        } catch (cause) {
            this.#logger.debug({ err: cause }, 'lock inspect failed');
            return 'another instance';
        }
    }

    #scheduleRenew(): void {
        this.#clearHeartbeat();
        // spec/config.yaml#lock.renew_ratio. At the default 0.33 a renew has roughly
        // three attempts before the lease runs out.
        const delay = Math.max(1, Math.floor(this.#config.lock.ttlMs * this.#config.lock.renewRatio));

        this.#heartbeat = setTimeout(() => void this.#renew(), delay);
        // The heartbeat must never be the reason a process stays alive: an idle
        // program holding a lock should still be allowed to exit.
        this.#heartbeat.unref?.();
    }

    #clearHeartbeat(): void {
        if (this.#heartbeat !== undefined) clearTimeout(this.#heartbeat);
        this.#heartbeat = undefined;
    }

    async #renew(): Promise<void> {
        this.#heartbeat = undefined;

        const lock = this.#lockProvider;
        const held = this.#held;
        if (lock === undefined || held === undefined || this.#destroyed) return;

        let renewed: LockToken | null;
        try {
            renewed = await lock.renew(held, this.#config.lock.ttlMs);
        } catch (cause) {
            // A backend that failed to answer is not proof we were fenced, so this
            // retries -- but only while the lease we already hold is still valid.
            // Once it lapses we can no longer prove ownership, and continuing to run
            // on a lock we cannot demonstrate is the split-brain this exists to stop.
            this.#logger.warn({ err: cause }, 'lock renew failed');
            if (Date.now() > held.expiresAt) await this.#onFenced(held);
            else this.#scheduleRenew();
            return;
        }

        if (renewed === null) {
            await this.#onFenced(held);
            return;
        }

        this.#held = renewed;
        this.#scheduleRenew();
    }

    /**
     * Another instance owns the session now. Fail-stop.
     *
     * The socket goes down before anything is announced: two processes on one session
     * corrupt the Signal key store, so stopping is the urgent part and reporting is
     * not. Reconnect is suppressed -- coming back would just take the lock away from
     * whoever legitimately holds it.
     */
    async #onFenced(previous: LockToken): Promise<void> {
        this.#held = undefined;
        this.#suppressReconnect = true;
        this.#clearHeartbeat();
        this.#clearTimer();

        this.#machine.tryApply('fenced');
        await this.#closeSocket();

        const owner = await this.#ownerOf(previous.key);
        this.#logger.warn({ owner }, 'fenced');
        this.#emit('session.fenced', { owner });
    }

    /**
     * Gives the lock up. Failures are logged, never thrown: the caller is stopping,
     * and an unreleased lock lapses by itself within the TTL.
     */
    async #releaseLock(): Promise<void> {
        this.#clearHeartbeat();

        const held = this.#held;
        this.#held = undefined;
        if (this.#lockProvider === undefined || held === undefined) return;

        try {
            await this.#lockProvider.release(held);
        } catch (cause) {
            this.#logger.warn({ err: cause, detail: describeError(cause) }, 'lock release failed');
        }
    }

    /**
     * The driver's buffered batch.
     *
     * Our own handling runs first so that a listener reading `session.state` sees the
     * state this batch produced, then the batch is handed to the bus intact -- v1
     * re-split it into one call per event, discarding the batching the driver works
     * to provide.
     */
    async #onEvents(events: EventBatch): Promise<void> {
        try {
            await this.#handle(events);
        } catch (error) {
            this.#reportError(error, 'event');
        }

        this.#emitter.emitBatch(events, this.#meta());
    }

    async #handle(events: EventBatch): Promise<void> {
        if (events['creds.update'] !== undefined) await this.#auth?.saveCreds();

        const update = events['connection.update'];
        if (update === undefined) return;

        if (typeof update.qr === 'string') await this.#onQr(update.qr);

        if (update.connection === 'open') this.#onOpen();
        else if (update.connection === 'close') await this.#onClose(update.lastDisconnect?.error);
    }

    async #onQr(qr: string): Promise<void> {
        this.#sawQr = true;
        // A fresh QR invalidates any pairing code bound to the previous one.
        this.#pairingPending = false;
        this.#qrAttempt += 1;
        this.#machine.tryApply('qr');

        if (this.#qrAttempt > this.#config.qr.maxAttempts) {
            this.#logger.info({ attempts: this.#qrAttempt }, 'qr attempts exhausted');
            this.#suppressReconnect = true;
            this.#machine.tryApply('qr_exhausted');
            await this.#closeSocket();
            return;
        }

        // Suppressed under pairing: showing a QR for a session the caller is pairing
        // by phone code is noise, and scanning it would race the code.
        if (!this.#config.pairing.enabled) {
            this.#emit('qr', {
                qr,
                attempt: this.#qrAttempt,
                expiresAt: Date.now() + this.#config.qr.timeoutMs,
            });
        }
    }

    #onOpen(): void {
        this.#machine.tryApply('connected');
        this.#policy.reset();
        this.#qrAttempt = 0;
        this.#pairingPending = false;
    }

    async #onClose(error: unknown): Promise<void> {
        const decision = decideDisconnect(error);
        this.#logger.info({ cause: decision.cause, action: decision.action }, 'disconnected');

        this.#machine.tryApply(disconnectTrigger(decision.cause, this.#machine.state));
        this.#detachEvents();
        this.#socket = undefined;

        if (decision.purgeCreds) {
            await this.#purgeAuth();
            this.#emit('session.logged_out', { cause: decision.cause });
        }

        if (this.#suppressReconnect) return;

        const plan = this.#policy.plan(decision.cause);
        if (!plan.retry) {
            this.#logger.info({ cause: plan.cause, reason: plan.reason }, 'not reconnecting');
            return;
        }

        this.#emit('session.reconnecting', { attempt: plan.attempt, delayMs: plan.delayMs, cause: plan.cause });
        this.#timer = setTimeout(() => void this.#reconnect(), plan.delayMs);
    }

    async #reconnect(): Promise<void> {
        this.#timer = undefined;
        if (this.#suppressReconnect || this.#destroyed) return;

        // `restart_required` already moved us to `connecting`; everything else left
        // the session `closed` and needs the explicit edge.
        if (this.#machine.state === 'closed') this.#machine.tryApply('reconnect');
        if (this.#machine.state !== 'connecting') return;

        try {
            await this.#openSocket();
        } catch (error) {
            this.#machine.tryApply('disconnected');
            this.#reportError(error, 'reconnect');
        }
    }
}
