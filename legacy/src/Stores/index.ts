import { ConfigType } from '../Types/Connection';
import { Session } from '../Services/sessions';

export const sessions: Map<string, Session> = new Map();

let _config: ConfigType = {};

export const Configs = {
    set(newConfig: ConfigType) {
        _config = { ..._config, ...newConfig };
    },
    get(): ConfigType {
        return _config;
    },
    getValue<K extends keyof ConfigType>(key: K): ConfigType[K] {
        return _config[key];
    },
};
