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
import type { SocketConfig, WASocket } from '../compat/baileys.js';
import type { ResolvedConfig } from '../config.js';
import { WhatsMultiError, describeError, wrapError } from '../errors.js';
import type { WMEventEmitter } from '../events/emitter.js';
import type { EventBatch, EventMap, EventMeta, EventName } from '../events/types.js';
import type { SessionState } from '../generated/index.js';
import type { Logger } from '../logger.js';
import { normalizePhoneNumber } from '../messaging/jid.js';
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
    readonly #factory: SocketFactory;
    readonly #socketOptions: Partial<SocketConfig> | undefined;

    #auth: AuthStateHandle | undefined;
    #socket: WASocket | undefined;
    #detach: (() => void) | undefined;
    #timer: ReturnType<typeof setTimeout> | undefined;

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
        this.#policy = new ReconnectPolicy({ config: options.config.reconnect, random: options.random });
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

    get destroyed(): boolean {
        return this.#destroyed;
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

        try {
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
        await this.#closeSocket();
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

        const socket = this.#socket;
        if (socket === undefined || !this.#machine.is('open')) {
            throw new WhatsMultiError('SESSION_NOT_READY', {
                sessionId: this.sessionId,
                params: { sessionId: this.sessionId, state: this.#machine.state, expected: 'open' },
            });
        }

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
