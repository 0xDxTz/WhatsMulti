import {
    AuthenticationCreds,
    AuthenticationState,
    initAuthCreds,
    SignalDataSet,
    SignalDataTypeMap,
    SignalKeyStore,
} from '@whiskeysockets/baileys';
import { MetaSessionStoreType } from '../Types';

const memorySessions = new Map<
    string,
    {
        creds: AuthenticationCreds;
        keys: SignalDataSet;
        meta: MetaSessionStoreType | null;
    }
>();

export const useMemoryAuthState = async (
    sessionId: string
): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    setMeta: (value: MetaSessionStoreType) => Promise<void>;
    getMeta: () => Promise<MetaSessionStoreType | null>;
}> => {
    if (!memorySessions.has(sessionId)) {
        memorySessions.set(sessionId, {
            creds: initAuthCreds(),
            keys: {},
            meta: null,
        });
    }

    const session = memorySessions.get(sessionId)!;

    const keyStore: SignalKeyStore = {
        async get(type, ids) {
            const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
            for (const id of ids) {
                const val = session.keys[type]?.[id];
                if (val) data[id] = val;
            }
            return data;
        },
        async set(data) {
            for (const category in data) {
                const section = data[category as keyof SignalDataSet];
                if (!section) continue;
                session.keys[category as keyof SignalDataSet] ||= {};
                Object.assign(session.keys[category as keyof SignalDataSet]!, section);
            }
        },
        async clear() {
            for (const key in session.keys) delete session.keys[key as keyof SignalDataSet];
        },
    };

    return {
        state: {
            creds: session.creds,
            keys: keyStore,
        },
        saveCreds: async () => {},
        setMeta: async (value) => {
            session.meta = value;
        },
        getMeta: async () => session.meta,
    };
};
