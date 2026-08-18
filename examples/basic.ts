/**
 * One session, file storage, QR on the terminal, and a reply to `ping`.
 *
 * Run: npx tsx examples/basic.ts
 */
import { WhatsMulti } from 'whatsmulti';
import { printQr } from 'whatsmulti/qr';

const client = new WhatsMulti({
    // The default. Credentials that do not survive a restart mean pairing the phone
    // again on every deploy, which is never what someone wanted by accident.
    storage: 'file',
    logLevel: 'info',
});

client.on('qr', ({ qr, attempt, expiresAt }, { sessionId }) => {
    const seconds = Math.round((expiresAt - Date.now()) / 1000);
    console.log(`[${sessionId}] scan within ${seconds}s (attempt ${attempt})`);
    void printQr(qr);
});

client.on('session.state', ({ from, to }, { sessionId }) => {
    console.log(`[${sessionId}] ${from} -> ${to}`);
});

client.on('session.reconnecting', ({ attempt, delayMs, cause }, { sessionId }) => {
    console.warn(`[${sessionId}] ${cause}: retry ${attempt} in ${delayMs}ms`);
});

client.on('messages.upsert', async ({ messages }, { sessionId }) => {
    const message = messages[0];
    const from = message?.key.remoteJid;
    if (!message || !from || message.key.fromMe) return;

    const text = message.message?.conversation ?? message.message?.extendedTextMessage?.text ?? '';
    if (text.trim().toLowerCase() !== 'ping') return;

    await client.send(sessionId, from, { text: 'pong' }, { quoted: message });
});

await client.createSession('personal');

// Resolves once the socket is wired, not once the connection is open: an unpaired
// session waits in `awaiting_scan` for a scan that may never come.
await client.start('personal');

const shutdown = () => {
    void client.destroy().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
