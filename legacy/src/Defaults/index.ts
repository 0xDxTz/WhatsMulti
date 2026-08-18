import { SockConfig } from '../Types/Session';

export const LOCAL_CONNECTION_PATH = 'whatsmulti_sessions';

export const DEFAULT_CONNECTION_TYPE = 'local';

export const DEFAULT_SOCKET_CONFIG: Partial<SockConfig> = {
    browser: ['WhatsMulti', 'Chrome', '1.5.0'],
};
