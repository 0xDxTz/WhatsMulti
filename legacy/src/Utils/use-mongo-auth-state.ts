import { AuthenticationCreds, AuthenticationState, BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { getAuthModel } from './mongo-client';
import { UpdateWriteOpResult } from 'mongoose';
import { MetaSessionStoreType } from '../Types';

const useMongoAuthState = async (
    sessionId: string
): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    setMeta: (value: MetaSessionStoreType) => Promise<UpdateWriteOpResult>;
    getMeta: () => Promise<MetaSessionStoreType | null>;
}> => {
    const AuthStateModel = await getAuthModel(sessionId);

    const key = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-');

    const store = async (id: string, value: unknown) =>
        AuthStateModel.updateOne(
            { _id: key(id) },
            { $set: { data: JSON.stringify(value, BufferJSON.replacer) } },
            { upsert: true }
        );

    const load = async (id: string) => {
        const doc = await AuthStateModel.findOne({ _id: key(id) });
        return doc ? JSON.parse(doc.data, BufferJSON.reviver) : null;
    };

    const remove = async (id: string) => {
        await AuthStateModel.deleteOne({ _id: key(id) });
    };

    const creds: AuthenticationCreds = (await load('creds')) ?? initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const entries = await Promise.all(
                        ids.map(async (id) => {
                            let data = await load(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && data) {
                                data = proto.Message.AppStateSyncKeyData.fromObject(data);
                            }
                            return [id, data];
                        })
                    );
                    return Object.fromEntries(entries);
                },
                set: async (allKeys) => {
                    const tasks = Object.entries(allKeys).flatMap(([type, records]) =>
                        Object.entries(records as Record<string, unknown>).map(([id, value]) =>
                            value ? store(`${type}-${id}`, value) : remove(`${type}-${id}`)
                        )
                    );
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: async () => {
            await store('creds', creds);
        },

        setMeta: async (value) => store(`meta`, value),
        getMeta: async () => load('meta'),
    };
};

export { useMongoAuthState };
