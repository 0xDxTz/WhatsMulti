/**
 * The other end of examples/webhook.ts: a receiver that verifies the signature before
 * it trusts a byte of the payload.
 *
 * Nothing here is WhatsMulti-specific except the header name and the signing recipe,
 * both of which are specified in spec/webhook.md -- a receiver written against this
 * works unchanged against the Go build.
 *
 * Run: npx tsx examples/webhook-receiver.ts
 */
import { createServer } from 'node:http';

import { SIGNATURE_HEADER, verifySignature, type WebhookEnvelope } from 'whatsmulti/webhook';

const secret = process.env['WEBHOOK_SECRET'] ?? 'change-me';

const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));

    request.on('end', () => {
        // The raw bytes, not a re-serialised object: JSON.stringify(JSON.parse(body))
        // is a different string often enough to break every signature you send.
        const body = Buffer.concat(chunks).toString('utf8');
        const header = request.headers[SIGNATURE_HEADER];

        const ok =
            typeof header === 'string' &&
            verifySignature({
                body,
                header,
                secret,
                // Rejects a replayed delivery whose timestamp has aged out. The signed
                // payload is `<t>.<body>`, so `t` cannot be edited without resigning.
                toleranceSeconds: 300,
            });

        if (!ok) {
            response.writeHead(401).end();
            return;
        }

        const envelope = JSON.parse(body) as WebhookEnvelope;
        for (const event of envelope.events) {
            console.log(`${envelope.instanceId} ${event.sessionId} ${event.event}`);
        }

        // 2xx means delivered. Anything 5xx, 408 or 429 is retried with the same
        // bytes and the same `t`, so make this idempotent -- deduplicate on the
        // x-whatsmulti-delivery header if a repeat would cost something.
        response.writeHead(204).end();
    });
});

server.listen(4000, () => console.log('listening on http://127.0.0.1:4000'));
