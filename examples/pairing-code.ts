/**
 * Linking a device with an 8-digit code instead of a QR, for a user who cannot scan
 * a screen -- a headless server, or a phone that is the only device present.
 *
 * The session must be started and have produced at least one QR: the code is bound to
 * that QR reference, which is also why it expires with it.
 *
 * Run: npx tsx examples/pairing-code.ts 628123456789
 */
import { WhatsMulti, hasErrorCode } from 'whatsmulti';

const phoneNumber = process.argv[2];
if (phoneNumber === undefined) {
    console.error('usage: pairing-code.ts <phone number, digits only, with country code>');
    process.exit(1);
}

const client = new WhatsMulti({
    storage: 'file',
    pairing: { enabled: true },
});

client.on('pairing.code', ({ code, expiresAt }, { sessionId }) => {
    const seconds = Math.round((expiresAt - Date.now()) / 1000);
    console.log(`[${sessionId}] enter ${code} on the phone within ${seconds}s`);
    console.log('WhatsApp > Settings > Linked devices > Link with phone number');
});

client.on('session.state', ({ to }, { sessionId }) => {
    if (to === 'open') console.log(`[${sessionId}] linked`);
});

await client.createSession('headless');
await client.start('headless');

// The first QR is the signal that the socket is ready to issue a code.
await new Promise<void>((resolve) => client.once('qr', () => resolve()));

try {
    await client.requestPairingCode('headless', phoneNumber);
} catch (error) {
    // Retryable: the socket has not reached the point where it can issue one yet.
    if (hasErrorCode(error, 'PAIRING_UNAVAILABLE')) console.error('not ready yet, try again in a moment');
    else throw error;
}

process.on('SIGINT', () => void client.destroy().then(() => process.exit(0)));
