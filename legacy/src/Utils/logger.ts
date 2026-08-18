import pino from 'pino';
import { Configs } from '../Stores';

const logger = pino({
    level: Configs.getValue('LoggerLevel') || 'info',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            ignore: 'pid,hostname',
            messageFormat: ' [WhatsMulti] {msg}',
            customColors: 'error:red,warn:yellow,info:blue,debug:green',
        },
    },
});

const baileysLogger = pino({
    level: Configs.getValue('BaileysLoggerLevel') || 'silent',
});

export { logger, baileysLogger };
