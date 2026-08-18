import { LOCAL_CONNECTION_PATH } from './../Defaults/index';
import { AuthStateParamsType, AuthStateType } from '../Types/Connection';
import { useLocalAuthState } from './use-local-auth-state';
import { useMongoAuthState } from './use-mongo-auth-state';
import { connectToMongo, isMongoDBConnected } from './mongo-client';
import path from 'path';
import { useMemoryAuthState } from './use-memory-auth-state';

export const authState = async ({ sessionId, connectionType }: AuthStateParamsType): Promise<AuthStateType> => {
    const sessionDir = path.resolve(LOCAL_CONNECTION_PATH, sessionId);

    switch (connectionType) {
        case 'local':
            return useLocalAuthState(sessionDir);

        case 'memory':
            return useMemoryAuthState(sessionId);

        case 'mongodb':
            if (!isMongoDBConnected()) {
                await connectToMongo();
            }
            return useMongoAuthState(sessionId);
    }
};
