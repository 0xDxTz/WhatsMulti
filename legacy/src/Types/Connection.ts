import { AuthenticationState } from '@whiskeysockets/baileys';
import { LoggerLevel, MetaSessionStoreType } from './Session';
import { UpdateWriteOpResult } from 'mongoose';

export type ConnectionType = 'local' | 'mongodb' | 'memory';

export type AuthStateParamsType = {
    sessionId: string;
    connectionType: ConnectionType;
};
export type ConfigType = {
    defaultConnectionType?: ConnectionType;
    localConnectionPath?: string;
    LoggerLevel?: LoggerLevel;
    BaileysLoggerLevel?: LoggerLevel;
    mongoUri?: string;
};

export type AuthStateType = {
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    setMeta: (value: MetaSessionStoreType) => Promise<void | UpdateWriteOpResult>;
    getMeta: () => Promise<MetaSessionStoreType | null>;
};
