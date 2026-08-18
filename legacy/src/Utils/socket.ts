import { DEFAULT_SOCKET_CONFIG } from '../Defaults';
import { SockConfig } from '../Types/Session';

export const getSocketConfig = (config: Partial<SockConfig>) => {
    return {
        ...DEFAULT_SOCKET_CONFIG,
        ...config,
    };
};
