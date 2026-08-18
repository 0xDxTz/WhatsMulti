import { Configs, sessions } from '../Stores';
import { ConfigType, ConnectionType, SessionInstance, SockConfig } from '../Types';
import { getAllExistingSessions, logger, validateSessionId } from '../Utils';
import { Session } from './sessions';
import { WMEventEmitter } from './event';
import { MessageContentType, MessageOptionsType, MessageType } from '../Types/Messages';
import { MessageService } from './messages';

export class WhatsMulti extends WMEventEmitter {
    private sessions = sessions;
    private readonly messageService;
    config: ConfigType;

    constructor(config: ConfigType = {}) {
        super();
        Configs.set(config);
        this.messageService = new MessageService();
    }

    async createSession(
        id: string,
        connectionType: ConnectionType = 'local',
        socketConfig?: Partial<SockConfig>
    ): Promise<void> {
        if (!validateSessionId(id)) throw new Error('Invalid session id');
        if (this.sessions.has(id)) throw new Error('Session exists');
        const session = new Session(id, connectionType, socketConfig, (event, data, { sessionId, socket }) => {
            this.emit(event, data, {
                sessionId,
                socket,
            });
        });
        await session.init();
        this.sessions.set(id, session);
    }

    async startSession(id: string): Promise<void> {
        const s = this.sessions.get(id);
        if (!s) throw new Error('Session not found');
        await s.start();
    }

    async stopSession(id: string): Promise<void> {
        const s = this.sessions.get(id);
        if (!s) throw new Error('Session not found');
        await s.stop();
    }

    async deleteSession(id: string): Promise<void> {
        const s = this.sessions.get(id);
        if (!s) throw new Error('Session not found');
        await s.logout();
        this.sessions.delete(id);
    }

    async restartSession(id: string): Promise<void> {
        const s = this.sessions.get(id);
        if (!s) throw new Error('Session not found');
        await s.restart();
    }

    async logoutSession(id: string): Promise<void> {
        const s = this.sessions.get(id);
        if (!s) throw new Error('Session not found');
        await s.logout();
    }

    async getSession(id: string): Promise<SessionInstance | undefined> {
        const s = this.sessions.get(id);
        if (!s) return undefined;
        return {
            id: s.id,
            connectionType: s.connectionType,
            status: s.status,
            qr: s.qr,
        };
    }

    async getSessions(): Promise<SessionInstance[]> {
        return Array.from(this.sessions.values()).map((s) => ({
            id: s.id,
            connectionType: s.connectionType,
            status: s.status,
        }));
    }

    async getQr(id: string): Promise<{ image: string; qr: string } | undefined> {
        const s = this.sessions.get(id);
        if (!s) throw new Error('Session not found');
        return s.qr;
    }

    async loadSessions(): Promise<void> {
        const sessionIds = await getAllExistingSessions();

        const tasks = sessionIds.map(({ id, connectionType }) =>
            this.createSession(id, connectionType).catch((err) => {
                logger.error(`Failed to create session ${id}:`, err);
            })
        );

        await Promise.all(tasks);
    }

    async sendMessage(
        sessionId: string,
        recipient: string | MessageType,
        message: MessageContentType,
        options?: MessageOptionsType
    ) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error('Session not found');

        await this.messageService.send(s.socket, recipient, message, options);
    }
}
