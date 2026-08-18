/**
 * Forwarding events to an HTTP endpoint, signed.
 *
 * Deliveries are posted one at a time and in order: parallel posts with independent
 * retries would routinely show a receiver `session.state open` before the `qr` that
 * preceded it.
 *
 * Run: npx tsx examples/webhook.ts
 */
import { WhatsMulti } from 'whatsmulti';
import { webhook } from 'whatsmulti/webhook';

const client = new WhatsMulti({ storage: 'file' });

client.use(
    webhook({
        url: process.env['WEBHOOK_URL'] ?? 'https://example.com/hooks/whatsapp',
        secret: process.env['WEBHOOK_SECRET'] ?? 'change-me',

        // Canonical names from spec/events.yaml, never the driver's own. Omit the
        // list to forward everything that crosses the wire.
        events: ['message.received', 'session.state', 'session.logged_out'],

        // 0 posts each driver batch as it arrives. Raise it to trade latency for
        // fewer requests; maxBatchSize caps how much one request may carry.
        batchWindowMs: 0,
        maxBatchSize: 100,

        // The same full-jitter schedule the reconnect policy uses.
        retry: { maxAttempts: 5, baseMs: 1_000, capMs: 60_000 },

        // Bounded, and it says so: a receiver that is down must not turn into
        // unbounded memory growth in a process that is otherwise healthy.
        maxQueue: 1000,
        onDeadLetter: (letter) => {
            console.error(`dropped ${letter.events.length} event(s): ${letter.reason}`, {
                attempts: letter.attempts,
                status: letter.status,
            });
        },

        headers: { 'x-tenant': 'acme' },
    })
);

await client.createSession('personal');
await client.start('personal');

// destroy() disposes plugins after the sessions stop, so the forwarder sees the final
// events and flushes them before it is torn down.
process.on('SIGINT', () => void client.destroy().then(() => process.exit(0)));
