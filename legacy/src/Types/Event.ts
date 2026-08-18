import { BaileysEventMap, WASocket } from '@whiskeysockets/baileys';

export type EventMap = BaileysEventMap & {
    qr: { image: string; qr: string };
    close: object;
    connecting: object;
    open: object;
};

export type EventMapKey = keyof EventMap;

export type MetaEventCallbackType = {
    sessionId: string;
    socket?: WASocket;
};
