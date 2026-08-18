/**
 * The REST + SSE control plane, contract-defined by spec/openapi.yaml.
 *
 * It is a thin shell over a `WhatsMulti` instance and owns no session state of its
 * own: every route is a call the caller could have made in process. That is what
 * keeps this build and the Go one answering the same way -- the behaviour lives under
 * the facade, and both servers only translate.
 *
 * Built on Hono because it runs unchanged on Node, Bun, Deno and the edge, and
 * returned as a web-standard `fetch` handler for the same reason: choosing the
 * listener is the deployment's business.
 */
import type { Context, Hono, MiddlewareHandler } from 'hono';

import type { WhatsMulti } from '../client.js';
import { WhatsMultiError } from '../errors.js';
import type { PairingCodeEvent } from '../events/types.js';
import { SPEC_VERSION, type SessionState } from '../generated/index.js';
import { silentLogger, type Logger } from '../logger.js';
import { parseJid } from '../messaging/jid.js';
import { resolveStorage } from '../storage/index.js';
import { encodeEvent } from '../webhook/envelope.js';

import { bearerAuth, resolveTokens } from './bearer.js';
import { loadHono } from './hono.js';
import { optionalBoolean, optionalObject, readJsonBody, requiredString, toErrorResponse } from './http.js';
import { LiveState, type StreamFilter } from './live.js';
import { METRICS_CONTENT_TYPE, RequestCounter, renderMetrics, routeTemplate } from './metrics.js';

export { bearerAuth, readBearer, resolveTokens, tokenMatches } from './bearer.js';
export { loadHono, setHonoLoader, type HonoLoader, type HonoRuntime } from './hono.js';
export { toErrorResponse, type ErrorResponse } from './http.js';
export { LiveState, type StreamFilter, type StreamListener } from './live.js';
export {
    METRICS_CONTENT_TYPE,
    RequestCounter,
    escapeLabel,
    renderMetrics,
    routeTemplate,
    type MetricsSnapshot,
    type RequestSample,
    type SessionSample,
} from './metrics.js';

export interface ServerOptions {
    readonly client: WhatsMulti;
    /** One token, or several so they can be rotated without a restart. */
    readonly token?: string | readonly string[] | undefined;
    /** Serve without authentication. Never the default; see the note in auth.ts. */
    readonly insecure?: boolean | undefined;
    /** Mounts every route under a prefix, e.g. `/api`. */
    readonly basePath?: string | undefined;
    readonly logger?: Logger | undefined;
    /**
     * Reported as the `version` label on `whatsmulti_build_info`.
     *
     * Passed in rather than read from package.json: reading a file at runtime breaks
     * the edge runtimes this server exists to run on, and generating it would tie a
     * hand-made version bump to a spec regeneration.
     */
    readonly version?: string | undefined;
    /** Frames buffered for one slow stream client before it is disconnected. */
    readonly streamBuffer?: number | undefined;
    /** Comment frame interval that keeps an idle stream alive through proxies. */
    readonly heartbeatMs?: number | undefined;
}

export interface ServerApp {
    /** Web-standard handler. Hand it to @hono/node-server, Bun.serve, Deno.serve. */
    readonly fetch: (request: Request) => Response | Promise<Response>;
    /** Ends every open stream and stops listening to the client. Idempotent. */
    close(): Promise<void>;
}

interface SessionBody {
    readonly id: string;
    readonly state: SessionState;
    readonly storage: string;
    readonly jid: string | null;
    readonly createdAt?: number;
    readonly updatedAt?: number;
}

const DEFAULT_STREAM_BUFFER = 1000;
const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * The `:id` segment. Typed as possibly-undefined by Hono on a bare Context, and an
 * empty one would otherwise reach the manager as a lookup for the session named "".
 */
function sessionParam(c: Context): string {
    const id = c.req.param('id');
    if (id === undefined || id === '') {
        throw new WhatsMultiError('INVALID_SESSION_ID', { params: { sessionId: String(id) } });
    }
    return id;
}

/** Whatever the phone is linked as, without the device suffix. */
function bareJid(client: WhatsMulti, sessionId: string): string | null {
    const raw = client.find(sessionId)?.socket?.user?.id;
    if (typeof raw !== 'string') return null;
    const parsed = parseJid(raw);
    return parsed === null ? null : `${parsed.user}@${parsed.server}`;
}

export async function createServer(options: ServerOptions): Promise<ServerApp> {
    const { client } = options;
    const logger = (options.logger ?? client.logger ?? silentLogger).child({ component: 'server' });
    const tokens = resolveTokens(options.token, options.insecure ?? false);
    const streamBuffer = options.streamBuffer ?? DEFAULT_STREAM_BUFFER;
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

    const { Hono, streamSSE } = await loadHono();
    const live = new LiveState(client);
    const requests = new RequestCounter();

    const base: Hono = new Hono();
    const app: Hono = options.basePath === undefined ? base : base.basePath(options.basePath);

    // ------------------------------------------------------------------ middleware

    // Counted after the handler ran, so the status is the one actually sent. The route
    // template comes from Hono's matcher rather than the path.
    const count: MiddlewareHandler = async (c, next) => {
        await next();
        requests.record(c.req.method, routeTemplate(c.req.routePath), c.res.status);
    };
    app.use('*', count);

    if (tokens.length > 0) {
        // Guarded by route rather than by exclusion: /healthz and /metrics stay open
        // because a liveness probe and a Prometheus scrape are not API clients, and a
        // bearer token in a scrape config is a token in a configuration repository.
        // Listing what is protected means a new route is closed until someone adds it
        // here, which is the direction that fails safely.
        const guard = bearerAuth(tokens);
        app.use('/sessions', guard);
        app.use('/sessions/*', guard);
        app.use('/events', guard);
    }

    app.onError((error, c) => {
        const { status, body } = toErrorResponse(error);
        if (status >= 500) logger.error({ err: error, path: c.req.path }, 'request failed');
        return c.json(body, status);
    });

    app.notFound((c) => {
        // The contract says every failure carries the Error shape. Hono's default is
        // a text/plain body, which is the one answer a client cannot parse.
        const { status, body } = toErrorResponse(
            new WhatsMultiError('ROUTE_NOT_FOUND', { params: { method: c.req.method, path: c.req.path } })
        );
        return c.json(body, status);
    });

    // -------------------------------------------------------------------- sessions

    const sessionBody = async (sessionId: string): Promise<SessionBody> => {
        const session = client.session(sessionId);
        const meta = await client.meta(sessionId);
        return {
            id: sessionId,
            state: session.state,
            storage: meta?.storage ?? client.storage.name,
            jid: bareJid(client, sessionId),
            ...(meta === null ? {} : { createdAt: meta.createdAt, updatedAt: meta.updatedAt }),
        };
    };

    app.get('/sessions', async (c) => {
        // Registered sessions, not stored ones: `state` is required by the contract
        // and a session that has never been loaded into this process has none.
        const sessions = await Promise.all(client.ids().map((id) => sessionBody(id)));
        return c.json({ sessions });
    });

    app.post('/sessions', async (c) => {
        const body = await readJsonBody(c);
        const id = requiredString(body, 'id');
        const autoStart = optionalBoolean(body, 'auto_start');
        const storage = body['storage'];

        if (storage !== undefined && typeof storage !== 'string') {
            throw new WhatsMultiError('INVALID_REQUEST', { params: { detail: 'storage must be a string' } });
        }

        // Only the shorthands are accepted over HTTP. A custom adapter is constructed
        // with credentials the operator holds, and an API caller naming one would be
        // choosing where an account's keys are written.
        const override =
            storage === undefined || storage === client.storage.name
                ? undefined
                : resolveStorage(storage as 'memory' | 'file');

        await client.createSession(id, {
            ...(override === undefined ? {} : { storage: override }),
            ...(autoStart === undefined ? {} : { autoStart }),
        });
        return c.json(await sessionBody(id), 201);
    });

    app.get('/sessions/:id', async (c) => c.json(await sessionBody(sessionParam(c))));

    app.delete('/sessions/:id', async (c) => {
        // Local removal only. Unlinking the phone is /logout -- v1 conflated the two,
        // so asking for cleanup silently unlinked the device.
        await client.remove(sessionParam(c));
        return c.body(null, 204);
    });

    const lifecycle =
        (action: 'start' | 'stop' | 'restart'): ((c: Context) => Promise<Response>) =>
        async (c) => {
            const id = sessionParam(c);
            await client[action](id);
            return c.json(await sessionBody(id), 202);
        };

    app.post('/sessions/:id/start', lifecycle('start'));
    app.post('/sessions/:id/stop', lifecycle('stop'));
    app.post('/sessions/:id/restart', lifecycle('restart'));

    app.post('/sessions/:id/logout', async (c) => {
        const id = sessionParam(c);
        // Read before, not after: a successful logout deregisters the session and
        // purges its metadata, so there is nothing left to describe by the time the
        // contract asks for a Session body.
        const before = await sessionBody(id);
        await client.logout(id);
        return c.json({ ...before, state: 'logged_out' as const, jid: null }, 202);
    });

    // -------------------------------------------------------------- qr and pairing

    app.get('/sessions/:id/qr', async (c) => {
        const id = sessionParam(c);
        // Asserts the session exists, so a typo in the id is a 404 about the session
        // rather than a 404 about the QR.
        client.session(id);

        const qr = live.qr(id);
        if (qr === undefined) {
            throw new WhatsMultiError('SESSION_NOT_FOUND', {
                sessionId: id,
                params: { sessionId: `${id} (no QR is outstanding)` },
            });
        }

        if (c.req.query('format') !== 'png') return c.json(qr);

        // The renderer is an optional peer; without it this is a 501 naming the
        // install command, not a 500.
        const { toBuffer } = await import('../qr/index.js');
        const png = await toBuffer(qr.qr);
        return c.body(new Uint8Array(png), 200, { 'content-type': 'image/png' });
    });

    app.post('/sessions/:id/pairing-code', async (c) => {
        const id = sessionParam(c);
        const body = await readJsonBody(c);
        const phoneNumber = requiredString(body, 'phone_number');

        const code = await client.requestPairingCode(id, phoneNumber);
        // The event carries the normalised number and the expiry; the call returns the
        // code alone. It is emitted before the promise settles, so it is already here.
        const issued: PairingCodeEvent | undefined = live.pairingCode(id);
        return c.json({
            code,
            phoneNumber: issued?.phoneNumber ?? phoneNumber,
            expiresAt: issued?.expiresAt ?? Date.now() + client.config.qr.timeoutMs,
        });
    });

    // -------------------------------------------------------------------- messages

    app.post('/sessions/:id/messages', async (c) => {
        const id = sessionParam(c);
        const body = await readJsonBody(c);
        const to = requiredString(body, 'to');
        const content = optionalObject(body, 'content');
        const sendOptions = optionalObject(body, 'options');

        if (content === undefined) {
            throw new WhatsMultiError('INVALID_REQUEST', { params: { detail: 'content must be an object' } });
        }

        // The content is whatever the driver accepts; validating its shape here would
        // mean tracking every message type Baileys grows.
        const sent = await client.send(
            id,
            to,
            content as Parameters<WhatsMulti['send']>[2],
            sendOptions as Parameters<WhatsMulti['send']>[3]
        );
        return c.json({ id: sent.key.id ?? '', to: sent.key.remoteJid ?? to });
    });

    // ---------------------------------------------------------------------- events

    app.get('/events', (c) => {
        const sessionId = c.req.query('session');
        const names = c.req.query('events');
        const filter: StreamFilter = {
            ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
            ...(names === undefined || names === ''
                ? {}
                : { events: new Set(names.split(',').map((name) => name.trim())) }),
        };

        return streamSSE(c, async (stream) => {
            const queue: string[] = [];
            let wake: (() => void) | undefined;
            let done = false;

            const nudge = (): void => {
                const resume = wake;
                wake = undefined;
                resume?.();
            };

            const unsubscribe = live.subscribe(
                filter,
                (event) => {
                    if (queue.length >= streamBuffer) {
                        // A client that cannot keep up is disconnected rather than
                        // buffered forever. Losing one consumer beats losing the process.
                        done = true;
                        logger.warn({ buffered: queue.length }, 'event stream client fell behind');
                        nudge();
                        return;
                    }
                    queue.push(encodeEvent(event));
                    nudge();
                },
                () => {
                    done = true;
                    nudge();
                }
            );

            stream.onAbort(() => {
                done = true;
                nudge();
            });

            try {
                while (!done && !stream.aborted) {
                    while (queue.length > 0) {
                        await stream.writeSSE({ data: queue.shift()! });
                    }
                    if (done || stream.aborted) break;

                    // The heartbeat is an SSE comment: it keeps proxies from closing an
                    // idle connection without looking like an event to the client.
                    const beat = await Promise.race([
                        new Promise<'event'>((resolve) => {
                            wake = () => resolve('event');
                        }),
                        stream.sleep(heartbeatMs).then(() => 'beat' as const),
                    ]);
                    if (beat === 'beat' && !done && !stream.aborted) await stream.write(': ping\n\n');
                }
            } finally {
                unsubscribe();
            }
        });
    });

    // ------------------------------------------------------------ health & metrics

    app.get('/healthz', (c) =>
        c.json({
            status: 'ok' as const,
            specVersion: SPEC_VERSION,
            runtime: 'ts' as const,
            instanceId: client.instanceId,
            sessions: client.size,
        })
    );

    app.get('/metrics', (c) => {
        const sessions = client.ids().map((id) => {
            const session = client.find(id);
            return { id, state: session?.state ?? 'idle', queueSize: session?.queueSize ?? 0 };
        });

        return c.text(
            renderMetrics({
                instanceId: client.instanceId,
                version: options.version ?? 'unknown',
                sessions,
                streamClients: live.clients,
                requests: requests.samples(),
            }),
            200,
            { 'content-type': METRICS_CONTENT_TYPE }
        );
    });

    return {
        fetch: (request: Request) => base.fetch(request),
        close: async () => {
            live.close();
            // Nothing else to await: the client is the caller's to destroy, and doing
            // it here would stop sessions a second server may still be serving.
            await Promise.resolve();
        },
    };
}
