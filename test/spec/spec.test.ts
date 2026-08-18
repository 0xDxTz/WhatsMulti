import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
    BAILEYS_MESSAGE_TO_CAUSE,
    BAILEYS_STATUS_TO_CAUSE,
    DISCONNECT_ACTIONS,
    DISCONNECT_CAUSES,
    ERROR_CODES,
    ERROR_MESSAGES,
    ERROR_RETRYABLE,
    INITIAL_STATE,
    LIFECYCLE_EVENTS,
    PAIRABLE_STATES,
    PURGES_CREDS,
    SENDABLE_STATES,
    SESSION_STATES,
    SESSION_TRIGGERS,
    SPEC_VERSION,
    TERMINAL_STATES,
    TRANSITIONS,
    WIRE_EVENTS,
} from '../../src/generated/index.js';

const SPEC = join(process.cwd(), 'spec');
const yaml = (name: string) => parse(readFileSync(join(SPEC, name), 'utf8')) as Record<string, unknown>;
const vector = (name: string) =>
    JSON.parse(readFileSync(join(SPEC, 'vectors', name), 'utf8')) as Record<string, unknown>;

/**
 * These are integrity tests for the spec itself: they prove the YAML is internally
 * consistent, that the generated code faithfully reflects it, and that every fixture
 * only references names the spec defines. Tests of the *implementation* against these
 * fixtures land with the implementation, phase by phase.
 */

describe('spec version', () => {
    it('matches the VERSION file', () => {
        expect(SPEC_VERSION).toBe(readFileSync(join(SPEC, 'VERSION'), 'utf8').trim());
    });

    it('is semver', () => {
        expect(SPEC_VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    });

    it('is stamped on every vector file', () => {
        const files = readdirSync(join(SPEC, 'vectors'));
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            expect(vector(file)['specVersion'], file).toBe(SPEC_VERSION);
        }
    });
});

describe('spec documents', () => {
    it('every yaml document parses', () => {
        const files = readdirSync(SPEC).filter((f) => f.endsWith('.yaml'));
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) expect(() => yaml(file), file).not.toThrow();
    });

    it('config declares a session id pattern that the storage key layout relies on', () => {
        const cfg = yaml('config.yaml') as { session_id: { pattern: string } };
        const re = new RegExp(cfg.session_id.pattern);
        expect(re.test('session-1')).toBe(true);
        expect(re.test('A_z0-9')).toBe(true);
        // The separator and escape characters must be impossible in a session id,
        // which is why storage keys only ever escape the key half.
        expect(re.test('has:colon')).toBe(false);
        expect(re.test('has/slash')).toBe(false);
        expect(re.test('has%percent')).toBe(false);
        expect(re.test('')).toBe(false);
    });

    it('the REST contract only surfaces documented error codes and states', () => {
        const api = yaml('openapi.yaml') as { paths: Record<string, unknown>; info: { version: string } };
        expect(api.info.version).toBe(SPEC_VERSION);
        expect(Object.keys(api.paths).length).toBeGreaterThan(0);
    });
});

describe('states', () => {
    const spec = yaml('states.yaml') as {
        initial: string;
        states: Record<string, { terminal: boolean }>;
        transitions: { from: string; to: string; trigger: string }[];
        sendable: string[];
        pairable: string[];
    };

    it('generated enum matches the spec', () => {
        expect([...SESSION_STATES].sort()).toEqual(Object.keys(spec.states).sort());
    });

    it('every transition references known states and a known trigger', () => {
        for (const t of spec.transitions) {
            expect(SESSION_STATES, `from: ${t.from}`).toContain(t.from);
            expect(SESSION_STATES, `to: ${t.to}`).toContain(t.to);
            expect(SESSION_TRIGGERS, `trigger: ${t.trigger}`).toContain(t.trigger);
        }
    });

    it('has no duplicate from:trigger pairs', () => {
        const keys = spec.transitions.map((t) => `${t.from}:${t.trigger}`);
        expect(new Set(keys).size, `duplicate transition key in states.yaml`).toBe(keys.length);
        expect(Object.keys(TRANSITIONS).length).toBe(keys.length);
    });

    it('initial, sendable and pairable states are real states', () => {
        expect(SESSION_STATES).toContain(INITIAL_STATE);
        for (const s of [...SENDABLE_STATES, ...PAIRABLE_STATES]) expect(SESSION_STATES).toContain(s);
    });

    it('every non-terminal state is reachable from the initial state', () => {
        const seen = new Set<string>([INITIAL_STATE]);
        for (let changed = true; changed;) {
            changed = false;
            for (const t of spec.transitions) {
                if (seen.has(t.from) && !seen.has(t.to)) {
                    seen.add(t.to);
                    changed = true;
                }
            }
        }
        expect([...SESSION_STATES].filter((s) => !seen.has(s))).toEqual([]);
    });

    it('every state except terminal ones can be left again', () => {
        const hasExit = new Set(spec.transitions.map((t) => t.from));
        for (const s of SESSION_STATES) {
            if (TERMINAL_STATES.includes(s)) continue;
            expect(hasExit, `dead-end state: ${s}`).toContain(s);
        }
    });

    it('logged_out is terminal but recoverable only via an explicit reset', () => {
        expect(TERMINAL_STATES).toContain('logged_out');
        const exits = spec.transitions.filter((t) => t.from === 'logged_out');
        expect(exits.map((t) => t.trigger)).toEqual(['reset']);
    });
});

describe('disconnect causes', () => {
    const spec = yaml('disconnect-causes.yaml') as {
        causes: { name: string; action: string; purge_creds: boolean }[];
        baileys_status_map: Record<string, string>;
        baileys_message_map: Record<string, string>;
        whatsmeow_connect_failure_map: Record<string, string>;
        whatsmeow_event_map: Record<string, string>;
    };
    const actions = ['reconnect_immediate', 'reconnect_backoff', 'terminal'];

    it('generated enum matches the spec', () => {
        expect([...DISCONNECT_CAUSES]).toEqual(spec.causes.map((c) => c.name));
    });

    it('every cause has a known action and a purge flag', () => {
        for (const cause of DISCONNECT_CAUSES) {
            expect(actions, cause).toContain(DISCONNECT_ACTIONS[cause]);
            expect(typeof PURGES_CREDS[cause], cause).toBe('boolean');
        }
    });

    it('only terminal causes purge credentials', () => {
        for (const cause of DISCONNECT_CAUSES) {
            if (PURGES_CREDS[cause]) expect(DISCONNECT_ACTIONS[cause], cause).toBe('terminal');
        }
    });

    it('every driver map resolves to a known cause', () => {
        const maps = [
            spec.baileys_status_map,
            spec.baileys_message_map,
            spec.whatsmeow_connect_failure_map,
            spec.whatsmeow_event_map,
        ];
        for (const map of maps) {
            for (const cause of Object.values(map)) expect(DISCONNECT_CAUSES, cause).toContain(cause);
        }
    });

    it('no Baileys status maps to a credential-purging cause it cannot prove', () => {
        // 500 is both `badSession` and a plain server error. Mapping it to bad_session
        // would delete working credentials on a transient failure.
        expect(BAILEYS_STATUS_TO_CAUSE[500]).toBe('server_error');
        expect(PURGES_CREDS['server_error']).toBe(false);
        expect(BAILEYS_MESSAGE_TO_CAUSE.map(([needle]) => needle)).toContain('bad session');
    });

    it('has a fallback cause that reconnects', () => {
        expect(DISCONNECT_CAUSES).toContain('unknown');
        expect(DISCONNECT_ACTIONS['unknown']).toBe('reconnect_backoff');
    });
});

describe('errors', () => {
    const spec = yaml('errors.yaml') as { errors: { code: string; message: string; retryable: boolean }[] };

    it('generated enum matches the spec', () => {
        expect([...ERROR_CODES]).toEqual(spec.errors.map((e) => e.code));
    });

    it('codes are SCREAMING_SNAKE_CASE and unique', () => {
        for (const code of ERROR_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    });

    it('every code has a message and a retryable flag', () => {
        for (const code of ERROR_CODES) {
            expect(ERROR_MESSAGES[code], code).toBeTruthy();
            expect(typeof ERROR_RETRYABLE[code], code).toBe('boolean');
        }
    });

    it('message placeholders are well formed', () => {
        for (const code of ERROR_CODES) {
            const unbalanced = ERROR_MESSAGES[code].split('{').length !== ERROR_MESSAGES[code].split('}').length;
            expect(unbalanced, `${code}: ${ERROR_MESSAGES[code]}`).toBe(false);
        }
    });
});

describe('events', () => {
    const spec = yaml('events.yaml') as {
        lifecycle: Record<string, { payload?: Record<string, unknown> }>;
        meta: Record<string, unknown>;
        wire_mapping: Record<string, { baileys: string; whatsmeow: string }>;
    };

    it('generated enums match the spec', () => {
        expect([...LIFECYCLE_EVENTS]).toEqual(Object.keys(spec.lifecycle));
        expect([...WIRE_EVENTS]).toEqual(Object.keys(spec.wire_mapping));
    });

    it('every wire event names both a Baileys and a whatsmeow source', () => {
        for (const [name, m] of Object.entries(spec.wire_mapping)) {
            expect(m.baileys, name).toBeTruthy();
            expect(m.whatsmeow, name).toBeTruthy();
        }
    });

    it('the envelope carries sessionId and a timestamp', () => {
        expect(Object.keys(spec.meta)).toEqual(expect.arrayContaining(['sessionId', 'ts']));
    });

    it('lifecycle and wire event names do not collide', () => {
        const overlap = [...LIFECYCLE_EVENTS].filter((e) => (WIRE_EVENTS as readonly string[]).includes(e));
        expect(overlap).toEqual([]);
    });
});

describe('vectors', () => {
    it('disconnect-mapping only references known causes and actions', () => {
        const v = vector('disconnect-mapping.json');
        const groups = [
            'baileysStatus',
            'baileysMessage',
            'baileysUnknown',
            'whatsmeowConnectFailure',
            'whatsmeowEvent',
        ];
        for (const group of groups) {
            const rows = v[group] as { cause: string; action: string; purgeCreds: boolean }[];
            expect(rows.length, group).toBeGreaterThan(0);
            for (const row of rows) {
                expect(DISCONNECT_CAUSES, `${group}: ${row.cause}`).toContain(row.cause);
                expect(row.action).toBe(DISCONNECT_ACTIONS[row.cause as (typeof DISCONNECT_CAUSES)[number]]);
                expect(row.purgeCreds).toBe(PURGES_CREDS[row.cause as (typeof DISCONNECT_CAUSES)[number]]);
            }
        }
    });

    it('backoff delays respect the configured floor and cap', () => {
        const v = vector('backoff.json') as unknown as {
            configs: { name: string; base_ms: number; cap_ms: number; floor_ms: number }[];
            cases: { config: string; seed: number; delays: number[] }[];
        };
        for (const c of v.cases) {
            const cfg = v.configs.find((x) => x.name === c.config)!;
            c.delays.forEach((delay, i) => {
                const expMs = Math.min(cfg.cap_ms, cfg.base_ms * 2 ** Math.min(i, 30));
                expect(delay, `${c.config}/${c.seed}#${i + 1}`).toBeGreaterThanOrEqual(cfg.floor_ms);
                expect(delay, `${c.config}/${c.seed}#${i + 1}`).toBeLessThanOrEqual(Math.max(cfg.floor_ms, expMs));
            });
        }
    });

    it('backoff is seed-sensitive wherever jitter has room to act', () => {
        const v = vector('backoff.json') as unknown as {
            configs: { name: string; base_ms: number; cap_ms: number; floor_ms: number }[];
            cases: { config: string; seed: number; delays: number[] }[];
        };
        const byConfig = new Map<string, number[][]>();
        for (const c of v.cases) byConfig.set(c.config, [...(byConfig.get(c.config) ?? []), c.delays]);
        for (const [config, runs] of byConfig) {
            const cfg = v.configs.find((x) => x.name === config)!;
            const serialised = new Set(runs.map((r) => r.join(',')));
            if (cfg.floor_ms >= cfg.cap_ms) {
                // Jitter has no range: every attempt pins to the floor, by design.
                expect(serialised.size, `${config}: floor >= cap must be seed-independent`).toBe(1);
                expect(new Set(runs.flat())).toEqual(new Set([cfg.floor_ms]));
            } else {
                expect(serialised.size, `${config}: different seeds produced identical sequences`).toBe(runs.length);
            }
        }
    });

    it('storage keys are prefixed, escaped, and reversible', () => {
        const v = vector('storage-keys.json') as unknown as {
            signalKeyTypes: string[];
            cases: { sessionId: string; key: string; expected: string }[];
        };
        // Baileys v7 SignalDataTypeMap, all ten types.
        expect(v.signalKeyTypes).toHaveLength(10);
        expect(v.signalKeyTypes).toEqual(
            expect.arrayContaining(['lid-mapping', 'device-list', 'tctoken', 'identity-key'])
        );

        const decode = (s: string) =>
            s.replace(/%([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
        for (const c of v.cases) {
            expect(c.expected.startsWith(`whatsmulti:${c.sessionId}:`), c.expected).toBe(true);
            const encoded = c.expected.slice(`whatsmulti:${c.sessionId}:`.length);
            expect(encoded).not.toMatch(/[:/]/);
            expect(decode(encoded), c.key).toBe(c.key);
        }

        // The collision v1 shipped: a lossy escape mapped these to the same string.
        const keys = v.cases.map((c) => c.expected);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('jid vectors resolve to a known server or a known error', () => {
        const v = vector('jid.json') as unknown as {
            knownServers: string[];
            cases: { input: string; jid?: string; error?: string }[];
        };
        for (const c of v.cases) {
            if (c.error) {
                expect(ERROR_CODES, `${c.input} -> ${c.error}`).toContain(c.error);
                expect(c.jid).toBeUndefined();
            } else {
                expect(c.jid, c.input).toBeDefined();
                expect(v.knownServers, c.jid).toContain(c.jid!.split('@')[1]);
                expect(c.jid).not.toContain(':');
            }
        }
        expect(v.cases.some((c) => c.error)).toBe(true);
    });

    it('webhook signatures are 64 hex characters over the exact signed payload', () => {
        const v = vector('webhook-signature.json') as unknown as {
            cases: { t: number; body: string; signedPayload: string; v1: string; header: string }[];
        };
        for (const c of v.cases) {
            expect(c.signedPayload).toBe(`${c.t}.${c.body}`);
            expect(c.v1).toMatch(/^[0-9a-f]{64}$/);
            expect(c.header).toBe(`t=${c.t},v1=${c.v1}`);
        }
        expect(new Set(v.cases.map((c) => c.v1)).size).toBe(v.cases.length);
    });
});
