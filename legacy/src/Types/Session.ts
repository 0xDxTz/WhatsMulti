import { SocketConfig, WAConnectionState, WASocket } from '@whiskeysockets/baileys';
import { ConnectionType } from './Connection';
import { EventMap } from './Event';

export type SessionStatusType = WAConnectionState;

export interface SessionInstance {
    id: string;
    connectionType: ConnectionType;
    status: SessionStatusType;
    qr?: EventMap['qr'];
}

export type CreateSessionOptionsType = object;

export type LoggerLevel = 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type SockConfig = SocketConfig & {
    disableQRRetry?: boolean;
    qrMaxWaitMs?: number;
    printQR?: boolean;
};

export type SessionStoreType = {
    sock: WASocket | null;
    status: SessionStatusType;
    metadata: MetaSessionStoreType;
    scanned?: boolean;
};

export type MetaSessionStoreType = Partial<SockConfig>;
