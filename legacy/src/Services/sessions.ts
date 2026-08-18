import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';
import makeWASocket, {
    ConnectionState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    WASocket,
} from '@whiskeysockets/baileys';
import { authState, baileysLogger, deleteSessionOnLocal, deleteSessionOnMongo, logger } from '../Utils';
import { AuthStateType, ConnectionType } from '../Types/Connection';
import { SessionStatusType, SockConfig } from '../Types/Session';
import { getSocketConfig } from '../Utils/socket';
import { EventMap, EventMapKey, MetaEventCallbackType } from '../Types';

export class Session {
    readonly id: string;
    readonly connectionType: ConnectionType;
    status: SessionStatusType = 'close';
    qr?: EventMap['qr'];
    socket?: WASocket;
    private auth!: AuthStateType;
    private socketConfig: Partial<SockConfig>;
    private logger;
    private forceStop = false;
    private eventCallbacks: <K extends EventMapKey>(event: K, data: EventMap[K], meta: MetaEventCallbackType) => void =
        () => {};

    constructor(
        id: string,
        connectionType: ConnectionType,
        sockConfig: Partial<SockConfig> = {},
        eventCallbacks: <K extends EventMapKey>(
            event: K,
            data: EventMap[K],
            meta: MetaEventCallbackType
        ) => void = () => {}
    ) {
        this.id = id;
        this.connectionType = connectionType;
        this.socketConfig = getSocketConfig(sockConfig);
        this.logger = logger;
        this.eventCallbacks = eventCallbacks;
    }

    async init() {
        const auth = await authState({
            sessionId: this.id,
            connectionType: this.connectionType,
        });

        const meta = await auth.getMeta();
        if (meta) {
            this.socketConfig = getSocketConfig(meta);
        }

        await auth.setMeta(this.socketConfig);

        this.auth = auth;
    }

    private emit<K extends EventMapKey>(event: K, data: EventMap[K]) {
        this.eventCallbacks(event, data, {
            sessionId: this.id,
            socket: this.socket,
        });
    }

    private async handleQr(qr: string) {
        const qrString = await QRCode.toString(qr, { type: 'terminal', small: true });
        const qrImage = await QRCode.toDataURL(qr, { type: 'image/png', errorCorrectionLevel: 'H' });

        if (this.socketConfig.printQR) {
            this.logger.info(`QR Code for session ${this.id}:\n${qrString}`);
        }

        const qrData = { image: qrImage, qr };
        this.emit('qr', qrData);
        this.qr = qrData;
    }

    private bindSocketEvents() {
        if (!this.socket) return;

        this.socket.ev.process(async (events: EventMap) => {
            for (const [evKey, evData] of Object.entries(events)) {
                switch (evKey) {
                    case 'creds.update': {
                        await this.auth.saveCreds();
                        break;
                    }

                    case 'connection.update': {
                        const update = evData as Partial<ConnectionState>;

                        if (update.qr) {
                            await this.handleQr(update.qr);
                        }

                        if (update.connection) {
                            this.emit(update.connection, update);

                            if (update.connection === 'open') {
                                this.status = 'open';
                                this.qr = undefined;
                            } else if (update.connection === 'close') {
                                this.status = 'close';
                                this.qr = undefined;

                                const code = (update.lastDisconnect?.error as Boom | undefined)?.output;
                                const needRestart = code?.statusCode === DisconnectReason.restartRequired;

                                if (!this.forceStop && needRestart) {
                                    await this.start().catch((err) => this.logger.error({ err }, 'Failed to restart'));
                                }
                            }
                        }

                        break;
                    }

                    default: {
                        this.emit(evKey as EventMapKey, evData);
                        break;
                    }
                }
            }
        });
    }

    async start() {
        this.forceStop = false;
        if (!this.auth) await this.init();
        if (this.status === 'open' || this.status === 'connecting') return;
        const { version } = await fetchLatestBaileysVersion();
        this.status = 'connecting';
        this.socket = makeWASocket({
            auth: this.auth.state,
            version,
            logger: baileysLogger,
            ...this.socketConfig,
        });
        this.bindSocketEvents();
    }

    async stop() {
        if (!this.socket) return;
        this.forceStop = true;
        this.socket.end(new Error('Manual stop'));
        this.socket = undefined;
        this.status = 'close';
    }

    async restart() {
        await this.stop();
        await this.start();
    }

    async logout() {
        if (!this.socket) return;
        await this.socket.logout();
        switch (this.connectionType) {
            case 'local':
                deleteSessionOnLocal(this.id);
                break;
            case 'mongodb':
                await deleteSessionOnMongo(this.id);
                break;
        }
        this.qr = undefined;
        this.status = 'close';
    }
}
