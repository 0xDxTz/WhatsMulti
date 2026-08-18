#!/usr/bin/env node
/**
 * Compiles spec/*.yaml into src/generated/*.ts.
 *
 * The Go repo runs its own generator over the same directory. Hand-writing these
 * enums twice is how two runtimes drift, so nothing here is editable by hand.
 *
 * Usage:
 *   node scripts/generate.mjs           write files
 *   node scripts/generate.mjs --check   fail if the on-disk output is stale (CI)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'spec');
const OUT = join(ROOT, 'src', 'generated');
const CHECK = process.argv.includes('--check');

const readSpec = (name) => parse(readFileSync(join(SPEC, name), 'utf8'));
const specVersion = readFileSync(join(SPEC, 'VERSION'), 'utf8').trim();

const banner = (source) => `// Code generated from spec/${source} by scripts/generate.mjs. DO NOT EDIT.
// Spec version: ${specVersion}
`;

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const union = (values) => values.map(quote).join('\n    | ');

/** `as const` object literal from a plain map. */
const constMap = (entries, valueFn = quote) =>
    entries.map(([k, v]) => `    ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k)}: ${valueFn(v)},`).join('\n');

// --------------------------------------------------------------------------- states

function genStates() {
    const spec = readSpec('states.yaml');
    const names = Object.keys(spec.states);
    const terminal = names.filter((n) => spec.states[n].terminal);
    const triggers = [...new Set(spec.transitions.map((t) => t.trigger))].sort();

    return `${banner('states.yaml')}
export const SESSION_STATES = [
    ${names.map(quote).join(',\n    ')},
] as const;

export type SessionState =
    | ${union(names)};

export const SESSION_TRIGGERS = [
    ${triggers.map(quote).join(',\n    ')},
] as const;

export type SessionTrigger =
    | ${union(triggers)};

export const INITIAL_STATE: SessionState = ${quote(spec.initial)};

export const TERMINAL_STATES: readonly SessionState[] = [${terminal.map(quote).join(', ')}];

/** States in which an outbound send is legal. */
export const SENDABLE_STATES: readonly SessionState[] = [${spec.sendable.map(quote).join(', ')}];

/** States in which requestPairingCode is legal. */
export const PAIRABLE_STATES: readonly SessionState[] = [${spec.pairable.map(quote).join(', ')}];

/** Legal transitions, keyed \`from:trigger\`. Anything absent is an illegal move. */
export const TRANSITIONS: Readonly<Record<string, SessionState>> = {
${spec.transitions.map((t) => `    ${quote(`${t.from}:${t.trigger}`)}: ${quote(t.to)},`).join('\n')}
};
`;
}

// ---------------------------------------------------------------------- disconnect

function genDisconnect() {
    const spec = readSpec('disconnect-causes.yaml');
    const names = spec.causes.map((c) => c.name);
    const actions = [...new Set(spec.causes.map((c) => c.action))].sort();

    return `${banner('disconnect-causes.yaml')}
export const DISCONNECT_CAUSES = [
    ${names.map(quote).join(',\n    ')},
] as const;

export type DisconnectCause =
    | ${union(names)};

export type DisconnectAction =
    | ${union(actions)};

export const DISCONNECT_ACTIONS: Readonly<Record<DisconnectCause, DisconnectAction>> = {
${constMap(spec.causes.map((c) => [c.name, c.action]))}
};

/** Causes whose handling deletes the stored auth state. */
export const PURGES_CREDS: Readonly<Record<DisconnectCause, boolean>> = {
${constMap(
    spec.causes.map((c) => [c.name, c.purge_creds]),
    String
)}
};

/**
 * Baileys numeric status -> canonical cause. Single-valued by construction; see the
 * collision notes in spec/disconnect-causes.yaml.
 */
export const BAILEYS_STATUS_TO_CAUSE: Readonly<Record<number, DisconnectCause>> = {
${constMap(Object.entries(spec.baileys_status_map))}
};

/** Checked before the numeric map. Matching is case-insensitive substring. */
export const BAILEYS_MESSAGE_TO_CAUSE: readonly (readonly [string, DisconnectCause])[] = [
${Object.entries(spec.baileys_message_map)
    .map(([k, v]) => `    [${quote(k)}, ${quote(v)}],`)
    .join('\n')}
];
`;
}

// -------------------------------------------------------------------------- errors

function genErrors() {
    const spec = readSpec('errors.yaml');
    const codes = spec.errors.map((e) => e.code);

    return `${banner('errors.yaml')}
export const ERROR_CODES = [
    ${codes.map(quote).join(',\n    ')},
] as const;

export type ErrorCode =
    | ${union(codes)};

/** Message templates. \`{placeholder}\` slots are filled by the error constructor. */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
${constMap(spec.errors.map((e) => [e.code, e.message]))}
};

/** Whether repeating the identical call could plausibly succeed. */
export const ERROR_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
${constMap(
    spec.errors.map((e) => [e.code, e.retryable]),
    String
)}
};

/**
 * The status the REST control plane answers with. Shared by both runtimes, so an API
 * client that branches on the status never has to ask which build it is talking to.
 */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
${constMap(
    spec.errors.map((e) => [e.code, e.http]),
    String
)}
};
`;
}

// -------------------------------------------------------------------------- events

function genEvents() {
    const spec = readSpec('events.yaml');
    const lifecycle = Object.keys(spec.lifecycle);
    const wire = Object.entries(spec.wire_mapping);

    return `${banner('events.yaml')}
export const LIFECYCLE_EVENTS = [
    ${lifecycle.map(quote).join(',\n    ')},
] as const;

export type LifecycleEvent =
    | ${union(lifecycle)};

export const WIRE_EVENTS = [
    ${wire.map(([k]) => quote(k)).join(',\n    ')},
] as const;

export type WireEvent =
    | ${union(wire.map(([k]) => k))};

/** Driver-native event name -> canonical wire name. In-process names stay idiomatic. */
export const BAILEYS_EVENT_TO_WIRE: Readonly<Record<string, WireEvent>> = {
${constMap(wire.map(([canonical, m]) => [m.baileys, canonical]))}
};
`;
}

// --------------------------------------------------------------------------- write

const outputs = {
    'spec-version.ts': `${banner('VERSION')}
export const SPEC_VERSION = ${quote(specVersion)};
`,
    'states.ts': genStates(),
    'disconnect.ts': genDisconnect(),
    'errors.ts': genErrors(),
    'events.ts': genEvents(),
    'index.ts': `${banner('*')}
export * from './spec-version.js';
export * from './states.js';
export * from './disconnect.js';
export * from './errors.js';
export * from './events.js';
`,
};

mkdirSync(OUT, { recursive: true });

let stale = 0;
for (const [name, content] of Object.entries(outputs)) {
    const path = join(OUT, name);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (current === content) continue;
    if (CHECK) {
        console.error(`stale: src/generated/${name}`);
        stale++;
    } else {
        writeFileSync(path, content);
        console.log(`wrote: src/generated/${name}`);
    }
}

if (CHECK) {
    if (stale > 0) {
        console.error(`\n${stale} generated file(s) out of date. Run \`npm run gen\`.`);
        process.exit(1);
    }
    console.log('generated code is up to date');
}
