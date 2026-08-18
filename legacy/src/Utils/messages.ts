import { WAMessage } from '@whiskeysockets/baileys';

export const getJid = (recipient: string | WAMessage) => {
    let jid: string;

    if (typeof recipient === 'string') {
        jid = recipient.includes('@') ? recipient : `${recipient}@s.whatsapp.net`;
    } else if (recipient.key?.remoteJid) {
        jid = recipient.key.remoteJid;
    } else {
        throw new Error('Invalid recipient format. Must be a string or WAMessage with remoteJid.');
    }

    return jid;
};
