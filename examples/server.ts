/**
 * The REST + SSE control plane, so something outside Node can drive sessions.
 *
 * app.fetch is a web-standard handler: @hono/node-server takes it, and so do
 * Bun.serve and Deno.serve.
 *
 * Run: API_TOKEN=secret npx tsx examples/server.ts
 *
 *   curl -H "Authorization: Bearer $API_TOKEN" localhost:3000/sessions
 *   curl -H "Authorization: Bearer $API_TOKEN" -X POST localhost:3000/sessions \
 *        -d '{"id":"sales","storage":"file","auto_start":true}'
 *   curl -H "Authorization: Bearer $API_TOKEN" localhost:3000/sessions/sales/qr
 *   curl -N -H "Authorization: Bearer $API_TOKEN" 'localhost:3000/events?session=sales'
 */
import { serve } from '@hono/node-server';

import { WhatsMulti } from 'whatsmulti';
import { createServer } from 'whatsmulti/server';

const token = process.env['API_TOKEN'];
if (token === undefined) {
    // Serving open takes an explicit `insecure: true`. Defaulting to no auth is how a
    // control plane that can send messages as someone's account ends up on port 3000.
    console.error('set API_TOKEN, or pass insecure: true to serve without authentication');
    process.exit(1);
}

const client = new WhatsMulti({ storage: 'file' });

// Registers what is already stored, so GET /sessions answers with the full fleet
// rather than only the sessions this process has touched since boot.
await client.load();

const app = await createServer({
    client,
    // A list, so a token can be rotated without a restart.
    token: [token],
    version: '2.0.0',
    // basePath: '/api',
    streamBuffer: 1000,
    heartbeatMs: 30_000,
});

const server = serve({ fetch: app.fetch, port: 3000 }, (info) => {
    console.log(`http://127.0.0.1:${info.port}  (/healthz and /metrics are unauthenticated)`);
});

process.on('SIGTERM', () => {
    server.close();
    // Ends every open stream first, so no client is left holding a socket that will
    // never produce another frame.
    void app
        .close()
        .then(() => client.destroy())
        .then(() => process.exit(0));
});
