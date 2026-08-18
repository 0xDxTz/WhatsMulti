import { getJid } from '../Utils/messages';
import { MessageOptionsType } from '../Types';
import { MessageContentType, MessageType } from '../Types';
import { SocketType } from '../Types/Socket';

export class MessageService {
    async send(
        socket: SocketType,
        recipient: string | MessageType,
        message: MessageContentType,
        options?: MessageOptionsType
    ) {
        try {
            const jid = getJid(recipient);
            await socket.sendMessage(jid, message, options);
        } catch (error) {
            throw new Error(`Failed to send message: ${error.message}`);
        }
    }
}
