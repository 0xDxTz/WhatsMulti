#!/usr/bin/env node
/**
 * Produces spec/vectors/*.json -- the fixtures every runtime is tested against.
 *
 * This script IS the reference implementation of the algorithms in
 * spec/algorithms.md. It runs once, its output is committed, and CI never
 * regenerates it: changing a vector requires a deliberate spec/VERSION bump, which
 * is exactly the friction that stops a TypeScript-side "fix" from silently
 * redefining the contract the Go build is held to.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'spec');
const OUT = join(SPEC, 'vectors');
const specVersion = readFileSync(join(SPEC, 'VERSION'), 'utf8').trim();

const write = (name, body) => {
    writeFileSync(join(OUT, name), JSON.stringify({ specVersion, ...body }, null, 2) + '\n');
    console.log(`wrote: spec/vectors/${name}`);
};

// ------------------------------------------------------- algorithms.md section 1+2

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
        t = (t ^ (t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0))) >>> 0;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function backoff(attempt, cfg, rand) {
    const shift = Math.min(attempt - 1, 30);
    const expMs = Math.min(cfg.cap_ms, cfg.base_ms * 2 ** shift);
    if (expMs <= cfg.floor_ms) return cfg.floor_ms;
    return cfg.floor_ms + Math.floor(rand() * (expMs - cfg.floor_ms));
}

function backoffVectors() {
    const configs = [
        { name: 'default', base_ms: 1000, cap_ms: 60000, floor_ms: 250 },
        { name: 'tight', base_ms: 200, cap_ms: 2000, floor_ms: 100 },
        { name: 'floor_dominates', base_ms: 100, cap_ms: 400, floor_ms: 500 },
    ];
    const seeds = [1, 42, 2166136261];
    const cases = [];
    for (const cfg of configs) {
        for (const seed of seeds) {
            const rand = mulberry32(seed);
            cases.push({
                config: cfg.name,
                seed,
                delays: Array.from({ length: 12 }, (_, i) => backoff(i + 1, cfg, rand)),
            });
        }
    }
    return {
        description:
            'Feed each config a fresh mulberry32 seeded with `seed`, then call backoff(attempt) for attempt 1..12. Delays must match exactly.',
        prng: 'mulberry32, spec/algorithms.md section 1',
        configs,
        cases,
        prngProbe: {
            description:
                'First 8 raw mulberry32 outputs per seed, as float64. Use these to isolate a PRNG bug from a backoff bug.',
            values: Object.fromEntries(
                seeds.map((seed) => {
                    const rand = mulberry32(seed);
                    return [String(seed), Array.from({ length: 8 }, () => rand())];
                })
            ),
        },
    };
}

// --------------------------------------------------------- algorithms.md section 3

const RESERVED = new Set(['%', ':', '/']);
const encodeKey = (s) =>
    [...Buffer.from(s, 'utf8')]
        .map((b) => {
            const ch = String.fromCharCode(b);
            return RESERVED.has(ch) ? '%' + b.toString(16).toUpperCase().padStart(2, '0') : ch;
        })
        .join('');

const storageKey = (sessionId, key) => `whatsmulti:${sessionId}:${encodeKey(key)}`;

function storageKeyVectors() {
    const inputs = [
        ['session-1', 'creds'],
        ['session-1', 'meta'],
        ['s_1', 'pre-key-42'],
        ['s_1', 'session-628123456789.0'],
        ['s_1', 'sender-key-628123456789@s.whatsapp.net::628999@s.whatsapp.net'],
        ['s_1', 'app-state-sync-key-AAAAAB/c+d='],
        ['s_1', 'app-state-sync-version-critical_block'],
        ['s_1', 'lid-mapping-628123456789'],
        ['s_1', 'device-list-628123456789'],
        ['s_1', 'tctoken-628123456789@s.whatsapp.net'],
        ['s_1', 'identity-key-628123456789.0'],
        ['s_1', '100%-of/the:reserved'],
        ['A-Z_0-9', 'pre-key-1'],
    ];
    return {
        description:
            'storageKey(sessionId, key) must equal `expected`. Decoding `expected` back must return the original key -- v1 used a lossy escape and collided pre-key-5 with pre:key:5.',
        signalKeyTypes: [
            'pre-key',
            'session',
            'sender-key',
            'sender-key-memory',
            'app-state-sync-key',
            'app-state-sync-version',
            'lid-mapping',
            'device-list',
            'tctoken',
            'identity-key',
        ],
        reservedKeys: ['creds', 'meta'],
        cases: inputs.map(([sessionId, key]) => ({
            sessionId,
            key,
            expected: storageKey(sessionId, key),
            roundTrip: true,
        })),
    };
}

// --------------------------------------------------------- algorithms.md section 4

const SERVERS = new Set(['s.whatsapp.net', 'g.us', 'lid', 'broadcast', 'newsletter', 'call']);

function normalizeJid(input) {
    if (input.includes('@')) {
        const at = input.lastIndexOf('@');
        let user = input.slice(0, at);
        const server = input.slice(at + 1).toLowerCase();
        if (!SERVERS.has(server)) return { error: 'INVALID_JID' };
        const colon = user.indexOf(':');
        if (colon !== -1) user = user.slice(0, colon);
        if (user.length === 0) return { error: 'INVALID_JID' };
        return { jid: `${user}@${server}` };
    }
    const digits = input.replace(/\D/g, '');
    if (digits.length <= 6) return { error: 'INVALID_PHONE_NUMBER' };
    if (digits.startsWith('0')) return { error: 'INVALID_PHONE_NUMBER' };
    return { jid: `${digits}@s.whatsapp.net` };
}

function jidVectors() {
    const inputs = [
        '628123456789',
        '+62 812-3456-789',
        '+1 (555) 010-9999',
        '628123456789@s.whatsapp.net',
        '628123456789:12@s.whatsapp.net',
        '628123456789@S.WhatsApp.Net',
        '120363000000000000@g.us',
        '120363000000000000:5@g.us',
        '98765432109876@lid',
        'status@broadcast',
        '0123456@newsletter',
        '628123456789@call',
        '0812345678',
        '12345',
        '+62-81',
        '628123456789@example.com',
        '@s.whatsapp.net',
        'not a number',
    ];
    return {
        description:
            'normalizeJid(input) must produce `jid`, or fail with `error`. The two phone rules mirror whatsmeow PairPhone validation so neither runtime accepts input the other rejects.',
        knownServers: [...SERVERS],
        cases: inputs.map((input) => ({ input, ...normalizeJid(input) })),
    };
}

// ---------------------------------------------------------------------- webhook.md

function webhookVectors() {
    const secret = 'whsec_test_do_not_use_in_production';
    const bodies = [
        JSON.stringify({
            specVersion,
            instanceId: 'host:1234:a1b2c3',
            events: [
                {
                    event: 'session.state',
                    sessionId: 'session-1',
                    ts: 1755500000000,
                    data: { from: 'connecting', to: 'open' },
                },
            ],
        }),
        JSON.stringify({
            specVersion,
            instanceId: 'host:1234:a1b2c3',
            events: [
                { event: 'message.received', sessionId: 's_1', ts: 1755500000001, data: { messages: [] } },
                { event: 'message.received', sessionId: 's_1', ts: 1755500000002, data: { messages: [] } },
            ],
        }),
        JSON.stringify({ specVersion, instanceId: 'i', events: [] }),
    ];
    const timestamps = [1755500000, 1, 2147483647];
    return {
        description:
            'signature = hex(HMAC_SHA256(secret, `${t}.${body}`)). Sign the RAW body bytes; re-serialising the JSON changes bytes and breaks verification.',
        secret,
        toleranceSeconds: 300,
        cases: bodies.map((body, i) => {
            const t = timestamps[i];
            const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
            return { t, body, signedPayload: `${t}.${body}`, v1, header: `t=${t},v1=${v1}` };
        }),
    };
}

// ------------------------------------------------- disconnect-causes.yaml, derived

function disconnectVectors() {
    const spec = parse(readFileSync(join(SPEC, 'disconnect-causes.yaml'), 'utf8'));
    const byName = Object.fromEntries(spec.causes.map((c) => [c.name, c]));
    const expand = (cause) => ({ cause, action: byName[cause].action, purgeCreds: byName[cause].purge_creds });

    return {
        description:
            'Given a driver signal, an implementation must resolve the canonical cause, its action, and whether credentials are purged. Message matching runs before the numeric map.',
        baileysStatus: Object.entries(spec.baileys_status_map).map(([status, cause]) => ({
            status: Number(status),
            ...expand(cause),
        })),
        baileysMessage: Object.entries(spec.baileys_message_map).map(([needle, cause]) => ({
            message: `Connection failure: ${needle} detected`,
            ...expand(cause),
        })),
        baileysUnknown: [
            { status: 599, ...expand('unknown') },
            { status: 0, ...expand('unknown') },
        ],
        whatsmeowConnectFailure: Object.entries(spec.whatsmeow_connect_failure_map).map(([code, cause]) => ({
            code: Number(code),
            ...expand(cause),
        })),
        whatsmeowEvent: Object.entries(spec.whatsmeow_event_map).map(([event, cause]) => ({
            event,
            ...expand(cause),
        })),
    };
}

mkdirSync(OUT, { recursive: true });
write('backoff.json', backoffVectors());
write('storage-keys.json', storageKeyVectors());
write('jid.json', jidVectors());
write('webhook-signature.json', webhookVectors());
write('disconnect-mapping.json', disconnectVectors());
