import type { WASocket } from '../../src/compat/baileys.js';
import type { EventBatch } from '../../src/events/types.js';
import type { SocketFactory, SocketFactoryOptions } from '../../src/session/socket-factory.js';

/**
 * A scripted stand-in for a Baileys socket.
 *
 * The whole session lifecycle -- QR, pairing, open, every disconnect cause, reconnect
 * backoff, logout -- is reachable through this without a network, which is the point
 * of `Session` taking a socket factory instead of calling makeWASocket itself.
 */
export class FakeSocket {
    readonly socket: WASocket;
    readonly options: SocketFactoryOptions;

    ended = false;
    loggedOut = false;
    pairingRequests: string[] = [];

    /** Set to make the matching call reject. */
    endError: Error | undefined;
    logoutError: Error | undefined;
    pairingError: Error | undefined;
    pairingCode = 'ABCD1234';

    readonly #handlers = new Set<(events: EventBatch) => void | Promise<void>>();

    constructor(options: SocketFactoryOptions) {
        this.options = options;
        this.socket = {
            ev: {
                process: (handler: (events: EventBatch) => void | Promise<void>) => {
                    this.#handlers.add(handler);
                    return () => this.#handlers.delete(handler);
                },
            },
            end: (): Promise<void> => {
                this.ended = true;
                return this.endError === undefined ? Promise.resolve() : Promise.reject(this.endError);
            },
            logout: (): Promise<void> => {
                if (this.logoutError !== undefined) return Promise.reject(this.logoutError);
                this.loggedOut = true;
                return Promise.resolve();
            },
            requestPairingCode: (phoneNumber: string): Promise<string> => {
                this.pairingRequests.push(phoneNumber);
                return this.pairingError === undefined
                    ? Promise.resolve(this.pairingCode)
                    : Promise.reject(this.pairingError);
            },
            user: undefined,
        } as unknown as WASocket;
    }

    get attached(): boolean {
        return this.#handlers.size > 0;
    }

    /** Delivers a driver batch exactly as `ev.process` would. */
    async deliver(events: EventBatch): Promise<void> {
        for (const handler of [...this.#handlers]) await handler(events);
    }

    qr(qr = 'qr-payload'): Promise<void> {
        return this.deliver({ 'connection.update': { qr } });
    }

    open(): Promise<void> {
        return this.deliver({ 'connection.update': { connection: 'open' } });
    }

    /** A close carrying a Boom-shaped status, the way the driver reports one. */
    close(statusCode?: number, message = 'closed'): Promise<void> {
        const error =
            statusCode === undefined ? undefined : Object.assign(new Error(message), { output: { statusCode } });
        return this.deliver({
            'connection.update': { connection: 'close', lastDisconnect: { error, date: new Date(0) } },
        });
    }

    credsUpdate(): Promise<void> {
        return this.deliver({ 'creds.update': {} });
    }
}

export interface FakeDriver {
    readonly factory: SocketFactory;
    readonly sockets: FakeSocket[];
    /** The socket handed to the session most recently. */
    readonly last: FakeSocket;
}

export function fakeDriver(onCreate?: (socket: FakeSocket) => void): FakeDriver {
    const sockets: FakeSocket[] = [];

    return {
        sockets,
        get last(): FakeSocket {
            const socket = sockets.at(-1);
            if (socket === undefined) throw new Error('no socket has been created yet');
            return socket;
        },
        factory: (options) => {
            const socket = new FakeSocket(options);
            onCreate?.(socket);
            sockets.push(socket);
            return Promise.resolve(socket.socket);
        },
    };
}

/** A factory that fails, for the socket-open failure paths. */
export function failingDriver(error: Error): SocketFactory {
    return () => Promise.reject(error);
}
