import { describe, expect, it } from 'vitest';

import { SESSION_STATES, SPEC_VERSION } from '../../src/generated/index.js';
import { escapeLabel, RequestCounter, renderMetrics, routeTemplate } from '../../src/server/metrics.js';

const snapshot = (over: Partial<Parameters<typeof renderMetrics>[0]> = {}) =>
    renderMetrics({
        instanceId: 'host:1:abc',
        version: '2.0.0',
        sessions: [],
        streamClients: 0,
        requests: [],
        ...over,
    });

describe('renderMetrics', () => {
    it('emits the series spec/metrics.md names', () => {
        const body = snapshot();
        for (const name of [
            'whatsmulti_build_info',
            'whatsmulti_sessions',
            'whatsmulti_sessions_state',
            'whatsmulti_send_queue_depth',
            'whatsmulti_event_stream_clients',
            'whatsmulti_http_requests_total',
        ]) {
            expect(body).toContain(`# TYPE ${name} `);
        }
    });

    it('carries the build identity in labels rather than as a value', () => {
        // A version as a metric value is useless for arithmetic; as a label on a
        // constant gauge it joins cleanly against everything else.
        expect(snapshot()).toContain(
            `whatsmulti_build_info{version="2.0.0",spec_version="${SPEC_VERSION}",runtime="ts",instance_id="host:1:abc"} 1`
        );
    });

    it('emits every state, including the zeros', () => {
        // A gauge that disappears at zero makes alerting lie: the series stops rather
        // than reporting that nothing is happening.
        const body = snapshot({ sessions: [{ id: 'a', state: 'open', queueSize: 0 }] });
        for (const state of SESSION_STATES) {
            expect(body).toContain(`whatsmulti_sessions_state{state="${state}"} ${state === 'open' ? 1 : 0}`);
        }
    });

    it('counts sessions per state', () => {
        const body = snapshot({
            sessions: [
                { id: 'a', state: 'open', queueSize: 3 },
                { id: 'b', state: 'open', queueSize: 0 },
                { id: 'c', state: 'idle', queueSize: 0 },
            ],
        });
        expect(body).toContain('whatsmulti_sessions 3');
        expect(body).toContain('whatsmulti_sessions_state{state="open"} 2');
        expect(body).toContain('whatsmulti_send_queue_depth{session="a"} 3');
    });

    it('ends with a newline, as the format requires', () => {
        expect(snapshot().endsWith('\n')).toBe(true);
    });

    it('renders request counters', () => {
        const body = snapshot({ requests: [{ method: 'GET', route: '/sessions', status: 200, count: 7 }] });
        expect(body).toContain('whatsmulti_http_requests_total{method="GET",route="/sessions",status="200"} 7');
    });

    it('tolerates a state the enum does not know', () => {
        // Defensive: a session reporting an unexpected state must not drop the series.
        const body = snapshot({ sessions: [{ id: 'a', state: 'invented' as never, queueSize: 0 }] });
        expect(body).toContain('whatsmulti_sessions_state{state="invented"} 1');
    });
});

describe('escapeLabel', () => {
    it.each([
        ['plain', 'plain'],
        ['a"b', 'a\\"b'],
        ['a\\b', 'a\\\\b'],
        ['a\nb', 'a\\nb'],
    ])('escapes %j', (input, expected) => {
        expect(escapeLabel(input)).toBe(expected);
    });

    it('escapes inside a rendered label', () => {
        expect(snapshot({ instanceId: 'ho"st' })).toContain('instance_id="ho\\"st"');
    });
});

describe('routeTemplate', () => {
    it('converts Hono parameters to the spec notation', () => {
        expect(routeTemplate('/sessions/:id')).toBe('/sessions/{id}');
        expect(routeTemplate('/sessions/:id/messages')).toBe('/sessions/{id}/messages');
    });

    it('passes a static route through', () => {
        expect(routeTemplate('/healthz')).toBe('/healthz');
    });

    it.each([undefined, '', '/*'])('labels an unmatched request rather than the raw path (%s)', (routePath) => {
        // Otherwise every 404 from a scanner becomes its own time series.
        expect(routeTemplate(routePath)).toBe('unmatched');
    });
});

describe('RequestCounter', () => {
    it('counts by method, route and status', () => {
        const counter = new RequestCounter();
        counter.record('GET', '/sessions', 200);
        counter.record('GET', '/sessions', 200);
        counter.record('GET', '/sessions', 401);

        expect(counter.samples()).toEqual([
            { method: 'GET', route: '/sessions', status: 200, count: 2 },
            { method: 'GET', route: '/sessions', status: 401, count: 1 },
        ]);
    });

    it('starts empty', () => {
        expect(new RequestCounter().samples()).toEqual([]);
    });
});
