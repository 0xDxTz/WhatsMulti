import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import type { AuthenticationState, AuthenticationCreds } from '@whiskeysockets/baileys';
import { MetaSessionStoreType } from '../Types';

const fixName = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-');
const toPath = (dir: string, name: string) => join(dir, fixName(name) + '.json');

const useLocalAuthState = async (
    sessionId: string
): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    setMeta: (value: MetaSessionStoreType) => Promise<void>;
    getMeta: () => Promise<MetaSessionStoreType | null>;
}> => {
    const ensureDir = async () => {
        const info = await stat(sessionId).catch(() => null);
        if (info && !info.isDirectory()) throw new Error(`${sessionId} exists and is not a directory`);
        if (!info) await mkdir(sessionId, { recursive: true });
    };

    const save = async (id: string, data: unknown) => {
        await writeFile(toPath(sessionId, id), JSON.stringify(data, BufferJSON.replacer));
    };

    const load = async (id: string) => {
        try {
            const data = await readFile(toPath(sessionId, id), 'utf-8');
            return JSON.parse(data, BufferJSON.reviver);
        } catch {
            return null;
        }
    };

    const remove = async (id: string) => {
        try {
            await unlink(toPath(sessionId, id));
        } catch {
            // Ignore error if file does not exist
        }
    };

    await ensureDir();

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
                set: async (data) => {
                    const tasks = Object.entries(data).flatMap(([type, records]) =>
                        Object.entries(records).map(([id, value]) =>
                            value ? save(`${type}-${id}`, value) : remove(`${type}-${id}`)
                        )
                    );
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: async () => {
            await save('creds', creds);
        },

        setMeta: async (value) => save(`meta`, value),
        getMeta: async () => load('meta'),
    };
};

export { useLocalAuthState };
