export { useAuthState, type AuthStateHandle, type AuthStateOptions } from './auth-state.js';
export {
    bufferReplacer,
    bufferReviver,
    decodeJson,
    decodeValue,
    encodeJson,
    encodeValue,
    type EncodedBuffer,
} from './codec.js';
export {
    CREDS_KEY,
    META_KEY,
    RESERVED_KEY_NAMES,
    STORAGE_KEYS,
    isReservedKey,
    isSignalKeyType,
    parseSignalKey,
    signalKey,
    type ParsedSignalKey,
} from './keys.js';
