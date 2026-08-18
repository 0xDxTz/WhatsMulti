import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WhatsMulti } from '../../src/client.js';
import type { WASocket } from '../../src/compat/baileys.js';
import { SPEC_VERSION } from '../../src/generated/index.js';
import { createServer, type ServerApp } from '../../src/server/index.js';
import { memoryStorage } from '../../src/storage/memory.js';
import { fakeDriver, type FakeDriver } from '../fixtures/fake-socket.js';

import { checkResponse, isSecured, operations, responsesOf } from './openapi.js';

/**
 * The Phase 10 gate: every route answered by the real server, validated against
 * spec/openapi.yaml. An API client written against the document has to work against
 * this build and against the Go one, and the only way to know is to check the bytes
 * that actually come back.
 */
const TOKEN = 'test-token';
const BASE = 'http://control.test';

interface Harness {
    readonly client: WhatsMulti;
    readonly driver: FakeDriver;
    readonly app: ServerApp;
    call(path: string, init?: RequestInit & { readonly anonymous?: boolean }): Promise<Response>;
    /** Calls, then validates the body against the schema for that path and status. */
    contract(route: string, method: string, path: string, init?: RequestInit): Promise<[Response, unknown]>;
}

let harness: Harness;

beforeEach(async () => {
    const driver = fakeDriver();
    const client = new WhatsMulti({ logLevel: 'silent', storage: memoryStorage(), socketFactory: driver.factory });
    const app = await createServer({ client, token: TOKEN, version: '2.0.0-test' });

    const call: Harness['call'] = (path, init = {}) => {
        const { anonymous, headers, ...rest } = init;
        return Promise.resolve(
            app.fetch(
                new Request(`${BASE}${path}`, {
                    ...rest,
                    headers: {
                        ...(anonymous === true ? {} : { authorization: `Bearer ${TOKEN}` }),
                        ...(rest.body === undefined ? {} : { 'content-type': 'application/json' }),
                        ...(headers as Record<string, string> | undefined),
                    },
                })
            )
        );
    };

    harness = {
        client,
        driver,
        app,
        call,
        contract: async (route, method, path, init = {}) => {
            const response = await call(path, { method: method.toUpperCase(), ...init });
            const text = await response.clone().text();
            const body: unknown = text === '' ? undefined : (JSON.parse(text) as unknown);
            const result = checkResponse(route, method, response.status, body);
            expect(
                result.ok,
                `${method.toUpperCase()} ${route} -> ${response.status} (${result.pointer ?? 'no schema'}): ${result.errors}\n${text}`
            ).toBe(true);
            return [response, body];
        },
    };
});

afterEach(async () => {
    await harness.app.close();
    await harness.client.destroy();
});

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/** Registered, started, and holding a QR. */
async function withQr(id = 'session-1'): Promise<void> {
    await harness.client.createSession(id);
    await harness.client.start(id);
    await harness.driver.last.qr('qr-payload');
}

describe('the document', () => {
    it('describes the routes this server serves', () => {
        // Guards against the contract growing a path nobody implemented, which is how
        // a document stops describing the thing it documents.
        expect(
            operations()
                .map(([path, method]) => `${method.toUpperCase()} ${path}`)
                .sort()
        ).toEqual([
            'DELETE /sessions/{id}',
            'GET /events',
            'GET /healthz',
            'GET /metrics',
            'GET /sessions',
            'GET /sessions/{id}',
            'GET /sessions/{id}/qr',
            'POST /sessions',
            'POST /sessions/{id}/logout',
            'POST /sessions/{id}/messages',
            'POST /sessions/{id}/pairing-code',
            'POST /sessions/{id}/restart',
            'POST /sessions/{id}/start',
            'POST /sessions/{id}/stop',
        ]);
    });

    it('carries a default response on every operation', () => {
        // Statuses come from errors.yaml, so enumerating them per operation would be a
        // second list to keep in step. `default` is the promise that whatever the
        // status is, the body is the Error shape.
        for (const [path, method] of operations()) {
            expect(Object.keys(responsesOf(path, method)), `${method} ${path}`).toContain('default');
        }
    });
});

describe('sessions', () => {
    it('lists them', async () => {
        await harness.client.createSession('session-1');
        const [response, body] = await harness.contract('/sessions', 'get', '/sessions');

        expect(response.status).toBe(200);
        expect((body as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual(['session-1']);
    });

    it('creates one', async () => {
        const [response, body] = await harness.contract('/sessions', 'post', '/sessions', json({ id: 'session-1' }));

        expect(response.status).toBe(201);
        expect(body).toMatchObject({ id: 'session-1', state: 'idle', storage: 'memory', jid: null });
        expect(harness.client.has('session-1')).toBe(true);
    });

    it('creates one on a named backend', async () => {
        const [, body] = await harness.contract(
            '/sessions',
            'post',
            '/sessions',
            json({ id: 'session-1', storage: 'memory' })
        );
        expect((body as { storage: string }).storage).toBe('memory');
    });

    it('refuses a backend it does not know', async () => {
        // Only the shorthands are reachable over HTTP. A custom adapter carries the
        // credentials the operator chose; an API caller naming one would be picking
        // where an account's keys get written.
        const [response, body] = await harness.contract(
            '/sessions',
            'post',
            '/sessions',
            json({ id: 'session-1', storage: 'postgres' })
        );
        expect(response.status).toBe(422);
        expect((body as { code: string }).code).toBe('INVALID_CONFIG');
    });

    it('rejects a duplicate with 409', async () => {
        await harness.client.createSession('session-1');
        const [response, body] = await harness.contract('/sessions', 'post', '/sessions', json({ id: 'session-1' }));

        expect(response.status).toBe(409);
        expect((body as { code: string }).code).toBe('SESSION_EXISTS');
    });

    it('rejects an id the pattern forbids with 422', async () => {
        const [response, body] = await harness.contract('/sessions', 'post', '/sessions', json({ id: 'has spaces' }));
        expect(response.status).toBe(422);
        expect((body as { code: string }).code).toBe('INVALID_SESSION_ID');
    });

    it.each([
        ['a body that is not JSON', 'not json'],
        ['a body that is an array', '[]'],
        ['a body missing id', '{}'],
        ['an id that is not a string', '{"id":7}'],
        ['auto_start that is not a boolean', '{"id":"session-1","auto_start":"yes"}'],
        ['storage that is not a string', '{"id":"session-1","storage":7}'],
    ])('rejects %s with 400', async (_label, body) => {
        const [response, parsed] = await harness.contract('/sessions', 'post', '/sessions', { body });
        expect(response.status).toBe(400);
        expect((parsed as { code: string }).code).toBe('INVALID_REQUEST');
    });

    it('reads one', async () => {
        await harness.client.createSession('session-1');
        const [response, body] = await harness.contract('/sessions/{id}', 'get', '/sessions/session-1');

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ id: 'session-1', state: 'idle' });
        expect(body).toHaveProperty('createdAt');
    });

    it('reports the linked JID once the socket has a user', async () => {
        await harness.client.createSession('session-1');
        await harness.client.start('session-1');
        // The device suffix addresses one linked device; the contract wants the account.
        (harness.driver.last.socket as WASocket & { user?: { id: string } }).user = {
            id: '628123456789:12@s.whatsapp.net',
        };

        const [, body] = await harness.contract('/sessions/{id}', 'get', '/sessions/session-1');
        expect((body as { jid: string }).jid).toBe('628123456789@s.whatsapp.net');
    });

    it('404s an unknown one', async () => {
        const [response, body] = await harness.contract('/sessions/{id}', 'get', '/sessions/nope');
        expect(response.status).toBe(404);
        expect((body as { code: string }).code).toBe('SESSION_NOT_FOUND');
    });

    it('deletes one without unlinking the phone', async () => {
        await harness.client.createSession('session-1');
        await harness.client.start('session-1');
        const [response] = await harness.contract('/sessions/{id}', 'delete', '/sessions/session-1');

        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
        expect(harness.client.has('session-1')).toBe(false);
        // /logout is the one that unlinks. v1 conflated them, so asking for local
        // cleanup silently unlinked the device.
        expect(harness.driver.last.loggedOut).toBe(false);
    });
});

describe('lifecycle', () => {
    beforeEach(async () => {
        await harness.client.createSession('session-1');
    });

    it.each([
        ['start', 'connecting'],
        // A stopped session is `closed`, not `idle`: it has been open, and the
        // difference is what tells a caller it can be started again.
        ['stop', 'closed'],
        ['restart', 'connecting'],
    ])('%s answers 202 with the session', async (action, state) => {
        if (action !== 'start') await harness.client.start('session-1');

        const [response, body] = await harness.contract(
            `/sessions/{id}/${action}`,
            'post',
            `/sessions/session-1/${action}`
        );

        expect(response.status).toBe(202);
        expect((body as { state: string }).state).toBe(state);
    });

    it('logout unlinks the device', async () => {
        await harness.client.start('session-1');
        // Unlinking needs an open socket: the phone is told over the connection, and
        // there is nothing to tell it over while the session is still connecting.
        await harness.driver.last.open();
        const socket = harness.driver.last;

        const [response, body] = await harness.contract('/sessions/{id}/logout', 'post', '/sessions/session-1/logout');

        expect(response.status).toBe(202);
        expect(socket.loggedOut).toBe(true);
        // The session is gone by the time the response is written, so the body is the
        // one read before the unlink, carrying the state it ended in.
        expect((body as { state: string }).state).toBe('logged_out');
        expect(harness.client.has('session-1')).toBe(false);
    });

    it('404s an unknown session', async () => {
        const [response] = await harness.contract('/sessions/{id}/start', 'post', '/sessions/nope/start');
        expect(response.status).toBe(404);
    });
});

describe('qr', () => {
    it('serves the outstanding code', async () => {
        await withQr();
        const [response, body] = await harness.contract('/sessions/{id}/qr', 'get', '/sessions/session-1/qr');

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ qr: 'qr-payload', attempt: 1 });
    });

    it('404s when none is outstanding', async () => {
        await harness.client.createSession('session-1');
        const [response, body] = await harness.contract('/sessions/{id}/qr', 'get', '/sessions/session-1/qr');

        expect(response.status).toBe(404);
        expect((body as { code: string }).code).toBe('SESSION_NOT_FOUND');
    });

    it('404s a session that does not exist', async () => {
        const [response] = await harness.contract('/sessions/{id}/qr', 'get', '/sessions/nope/qr');
        expect(response.status).toBe(404);
    });

    it('stops serving it once the session opens', async () => {
        // The phone has accepted the code. Handing it out afterwards sends someone to
        // scan something that will never work.
        await withQr();
        await harness.driver.last.open();

        const [response] = await harness.contract('/sessions/{id}/qr', 'get', '/sessions/session-1/qr');
        expect(response.status).toBe(404);
    });

    it('renders a png when asked', async () => {
        await withQr();
        const response = await harness.call('/sessions/session-1/qr?format=png');

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        const bytes = new Uint8Array(await response.arrayBuffer());
        // The PNG magic number, so this is an image and not a JSON body mislabelled.
        expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });
});

describe('pairing code', () => {
    it('issues one', async () => {
        await withQr();
        const [response, body] = await harness.contract(
            '/sessions/{id}/pairing-code',
            'post',
            '/sessions/session-1/pairing-code',
            json({ phone_number: '628123456789' })
        );

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ code: 'ABCD-1234', phoneNumber: '628123456789' });
        expect((body as { expiresAt: number }).expiresAt).toBeGreaterThan(0);
    });

    it('409s before the session has seen a QR', async () => {
        await harness.client.createSession('session-1');
        const [response, body] = await harness.contract(
            '/sessions/{id}/pairing-code',
            'post',
            '/sessions/session-1/pairing-code',
            json({ phone_number: '628123456789' })
        );

        expect(response.status).toBe(409);
        expect((body as { code: string }).code).toBe('PAIRING_UNAVAILABLE');
    });

    it('422s a number the rules reject', async () => {
        await withQr();
        const [response, body] = await harness.contract(
            '/sessions/{id}/pairing-code',
            'post',
            '/sessions/session-1/pairing-code',
            json({ phone_number: '0812' })
        );

        expect(response.status).toBe(422);
        expect((body as { code: string }).code).toBe('INVALID_PHONE_NUMBER');
    });

    it('400s a missing number', async () => {
        await withQr();
        const [response] = await harness.contract(
            '/sessions/{id}/pairing-code',
            'post',
            '/sessions/session-1/pairing-code',
            json({})
        );
        expect(response.status).toBe(400);
    });
});

describe('messages', () => {
    async function opened(): Promise<void> {
        await harness.client.createSession('session-1');
        await harness.client.start('session-1');
        await harness.driver.last.open();
    }

    it('sends one', async () => {
        await opened();
        const [response, body] = await harness.contract(
            '/sessions/{id}/messages',
            'post',
            '/sessions/session-1/messages',
            json({ to: '628123456789', content: { text: 'hello' } })
        );

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ id: 'MSG1', to: '628123456789@s.whatsapp.net' });
        expect(harness.driver.last.sent[0]?.[1]).toEqual({ text: 'hello' });
    });

    it('409s a session that is not open', async () => {
        await harness.client.createSession('session-1');
        const [response, body] = await harness.contract(
            '/sessions/{id}/messages',
            'post',
            '/sessions/session-1/messages',
            json({ to: '628123456789', content: { text: 'hello' } })
        );

        expect(response.status).toBe(409);
        expect((body as { code: string }).code).toBe('SESSION_NOT_READY');
    });

    it.each([
        ['no recipient', { content: { text: 'x' } }],
        ['no content', { to: '628123456789' }],
        ['content that is not an object', { to: '628123456789', content: 'hello' }],
        ['content that is an array', { to: '628123456789', content: [] }],
        ['options that are not an object', { to: '628123456789', content: { text: 'x' }, options: [] }],
    ])('400s %s', async (_label, body) => {
        await opened();
        const [response] = await harness.contract(
            '/sessions/{id}/messages',
            'post',
            '/sessions/session-1/messages',
            json(body)
        );
        expect(response.status).toBe(400);
    });
});

describe('health and metrics', () => {
    it('reports health without a token', async () => {
        const [response, body] = await harness.contract('/healthz', 'get', '/healthz', { headers: {} });

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ status: 'ok', specVersion: SPEC_VERSION, runtime: 'ts' });
    });

    it('serves metrics without a token', async () => {
        const response = await harness.call('/metrics', { anonymous: true });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/plain');
    });
});

describe('authentication', () => {
    it.each(
        operations()
            .filter(([path, method]) => isSecured(path, method))
            .map(([path, method]) => [`${method.toUpperCase()} ${path}`, path, method] as const)
    )('%s requires a token', async (_label, path, method) => {
        const concrete = path.replace('{id}', 'session-1');
        const response = await harness.call(concrete, { method: method.toUpperCase(), anonymous: true });

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toContain('Bearer');

        const body: unknown = await response.json();
        expect((body as { code: string }).code).toBe('UNAUTHORIZED');
        expect(checkResponse(path, method, 401, body).ok).toBe(true);
    });

    it('rejects the wrong token', async () => {
        const response = await harness.call('/sessions', { headers: { authorization: 'Bearer nope' } });
        expect(response.status).toBe(401);
    });

    it('accepts any configured token', async () => {
        const client = new WhatsMulti({ logLevel: 'silent', storage: memoryStorage() });
        const app = await createServer({ client, token: ['a', 'b'] });
        try {
            for (const token of ['a', 'b']) {
                const response = await app.fetch(
                    new Request(`${BASE}/sessions`, { headers: { authorization: `Bearer ${token}` } })
                );
                expect(response.status).toBe(200);
            }
        } finally {
            await app.close();
            await client.destroy();
        }
    });

    it('serves open when insecure is asked for explicitly', async () => {
        const client = new WhatsMulti({ logLevel: 'silent', storage: memoryStorage() });
        const app = await createServer({ client, insecure: true });
        try {
            expect((await app.fetch(new Request(`${BASE}/sessions`))).status).toBe(200);
        } finally {
            await app.close();
            await client.destroy();
        }
    });

    it('refuses to start with neither a token nor insecure', async () => {
        const client = new WhatsMulti({ logLevel: 'silent', storage: memoryStorage() });
        await expect(createServer({ client })).rejects.toThrow(
            expect.objectContaining({ code: 'INVALID_CONFIG' }) as Error
        );
        await client.destroy();
    });
});

describe('unknown routes', () => {
    it('answer with the Error shape rather than a framework page', async () => {
        const response = await harness.call('/nope');
        expect(response.status).toBe(404);
        expect(response.headers.get('content-type')).toContain('application/json');

        const body: unknown = await response.json();
        expect((body as { code: string }).code).toBe('ROUTE_NOT_FOUND');
        expect((body as { message: string }).message).toContain('/nope');
    });

    it('answer the same way for a method with no handler', async () => {
        const response = await harness.call('/healthz', { method: 'DELETE' });
        expect(response.status).toBe(404);
        expect(((await response.json()) as { code: string }).code).toBe('ROUTE_NOT_FOUND');
    });
});

describe('basePath', () => {
    it('mounts every route under the prefix', async () => {
        const client = new WhatsMulti({ logLevel: 'silent', storage: memoryStorage() });
        const app = await createServer({ client, token: TOKEN, basePath: '/api' });
        try {
            const headers = { authorization: `Bearer ${TOKEN}` };
            expect((await app.fetch(new Request(`${BASE}/api/healthz`))).status).toBe(200);
            expect((await app.fetch(new Request(`${BASE}/api/sessions`, { headers }))).status).toBe(200);
            expect((await app.fetch(new Request(`${BASE}/sessions`, { headers }))).status).toBe(404);
            // The prefix must not disable the guard.
            expect((await app.fetch(new Request(`${BASE}/api/sessions`))).status).toBe(401);
        } finally {
            await app.close();
            await client.destroy();
        }
    });
});

/** The reader result, named here because @types/node does not export the DOM type. */
interface Chunk {
    readonly done: boolean;
    readonly value?: Uint8Array | undefined;
}

describe('the event stream', () => {
    /** Reads frames until `count` `data:` lines have arrived, or the deadline passes. */
    async function frames(response: Response, count: number, timeoutMs = 2000): Promise<string[]> {
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        const seen: string[] = [];
        const deadline = Date.now() + timeoutMs;

        try {
            let buffered = '';
            while (seen.length < count && Date.now() < deadline) {
                const chunk = await Promise.race([
                    reader.read() as Promise<Chunk>,
                    new Promise<Chunk>((resolve) =>
                        setTimeout(() => resolve({ done: true }), Math.max(1, deadline - Date.now()))
                    ),
                ]);
                if (chunk.done || chunk.value === undefined) break;
                buffered += decoder.decode(chunk.value, { stream: true });
                for (const line of buffered.split('\n')) {
                    if (line.startsWith('data: ')) seen.push(line.slice(6));
                }
                buffered = '';
            }
        } finally {
            await reader.cancel();
        }
        return seen;
    }

    it('streams events as they happen', async () => {
        const response = await harness.call('/events');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');

        const collected = frames(response, 2);
        await harness.client.createSession('session-1');
        await harness.client.start('session-1');

        const seen = (await collected).map((frame) => JSON.parse(frame) as { event: string; sessionId: string });
        expect(seen.map((e) => e.event)).toContain('session.created');
        for (const event of seen) {
            expect(event.sessionId).toBe('session-1');
            // Each frame is one EventEnvelope, the same shape the webhook posts.
            expect(checkResponse('/events', 'get', 200, event, 'text/event-stream').ok).toBe(true);
        }
    });

    it('filters by session', async () => {
        const response = await harness.call('/events?session=session-2');
        const collected = frames(response, 1);

        await harness.client.createSession('session-1');
        await harness.client.createSession('session-2');

        const seen = (await collected).map((frame) => JSON.parse(frame) as { sessionId: string });
        expect(seen.length).toBeGreaterThan(0);
        for (const event of seen) expect(event.sessionId).toBe('session-2');
    });

    it('filters by event name, using the canonical names', async () => {
        const response = await harness.call('/events?events=session.state');
        const collected = frames(response, 1);

        await harness.client.createSession('session-1');
        await harness.client.start('session-1');

        const seen = (await collected).map((frame) => JSON.parse(frame) as { event: string });
        expect(seen.length).toBeGreaterThan(0);
        for (const event of seen) expect(event.event).toBe('session.state');
    });

    it('counts its clients, and lets go of them', async () => {
        const response = await harness.call('/events');
        // The stream is only registered once the handler runs, which is once the body
        // is being read.
        void frames(response, 1, 200);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const metrics = await (await harness.call('/metrics')).text();
        expect(metrics).toContain('whatsmulti_event_stream_clients 1');

        await harness.app.close();
        expect(await (await harness.call('/metrics')).text()).toContain('whatsmulti_event_stream_clients 0');
    });

    it('requires a token like every other route', async () => {
        const response = await harness.call('/events', { anonymous: true });
        expect(response.status).toBe(401);
    });
});

describe('metrics', () => {
    it('reports build info, sessions and requests', async () => {
        await harness.client.createSession('session-1');
        await harness.call('/sessions');

        const body = await (await harness.call('/metrics')).text();

        expect(body).toContain('whatsmulti_build_info{version="2.0.0-test"');
        expect(body).toContain(`spec_version="${SPEC_VERSION}"`);
        expect(body).toContain('runtime="ts"');
        expect(body).toContain('whatsmulti_sessions 1');
        expect(body).toContain('whatsmulti_sessions_state{state="idle"} 1');
        expect(body).toContain('whatsmulti_send_queue_depth{session="session-1"} 0');
        expect(body).toContain('whatsmulti_http_requests_total{method="GET",route="/sessions",status="200"} 1');
    });

    it('labels routes by template, never by session id', async () => {
        await harness.client.createSession('session-1');
        await harness.call('/sessions/session-1');

        const body = await (await harness.call('/metrics')).text();
        expect(body).toContain('route="/sessions/{id}"');
        // A label whose cardinality follows user data is how a Prometheus server runs
        // out of memory.
        expect(body).not.toContain('route="/sessions/session-1"');
    });

    it('emits a zero for every state', async () => {
        const body = await (await harness.call('/metrics')).text();
        for (const state of ['idle', 'connecting', 'open', 'closed', 'logged_out']) {
            expect(body).toContain(`whatsmulti_sessions_state{state="${state}"}`);
        }
    });
});
