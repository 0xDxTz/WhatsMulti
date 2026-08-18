/**
 * JID normalisation, normative in spec/algorithms.md section 4 and pinned by
 * spec/vectors/jid.json.
 *
 * The two phone-number rules mirror whatsmeow's `PairPhone` validation exactly, so
 * the TypeScript build cannot accept an input the Go build would reject -- which
 * matters most for pairing, where the server, not the library, is the thing that
 * rejects a bad number, and does so long after the call returned.
 */
import { WhatsMultiError } from '../errors.js';

export const KNOWN_SERVERS = ['s.whatsapp.net', 'g.us', 'lid', 'broadcast', 'newsletter', 'call'] as const;

export type KnownServer = (typeof KNOWN_SERVERS)[number];

export const DEFAULT_SERVER: KnownServer = 's.whatsapp.net';

export function isKnownServer(server: string): server is KnownServer {
    return (KNOWN_SERVERS as readonly string[]).includes(server);
}

const invalidJid = (input: string) => new WhatsMultiError('INVALID_JID', { params: { input } });

const invalidPhone = (detail: string) => new WhatsMultiError('INVALID_PHONE_NUMBER', { params: { detail } });

/**
 * Digits only, validated the way the pairing endpoint validates.
 *
 * Both rules exist because the failure they prevent is invisible: a number in
 * national format (`08123...`) is accepted by every regex you would write for it and
 * then silently fails to pair.
 */
export function normalizePhoneNumber(input: string): string {
    const digits = input.replace(/\D/g, '');

    if (digits.length <= 6) throw invalidPhone(`"${input}" has ${digits.length} digits, expected more than 6`);
    if (digits.startsWith('0')) throw invalidPhone(`"${input}" is in national format; use the country code instead`);

    return digits;
}

export interface ParsedJid {
    readonly user: string;
    readonly server: KnownServer;
    /** The device suffix that was stripped, when the input carried one. */
    readonly device?: string | undefined;
}

/** Splits a JID, or returns null if the input is not one. */
export function parseJid(input: string): ParsedJid | null {
    const at = input.indexOf('@');
    if (at === -1) return null;

    const server = input.slice(at + 1).toLowerCase();
    if (!isKnownServer(server)) return null;

    const raw = input.slice(0, at);
    const colon = raw.indexOf(':');
    const user = colon === -1 ? raw : raw.slice(0, colon);
    if (user.length === 0) return null;

    // The device suffix identifies one linked device. Addressing a message to it
    // would deliver to that device alone, so it is dropped everywhere we normalise.
    return colon === -1 ? { user, server } : { user, server, device: raw.slice(colon + 1) };
}

export function isJid(input: string): boolean {
    return parseJid(input) !== null;
}

/**
 * Accepts either a JID or a phone number and returns a canonical JID.
 *
 * An input containing `@` is treated as a JID even when it is malformed: falling back
 * to phone-number parsing would turn `628@example.com` into a message addressed to a
 * completely different, valid-looking JID.
 */
export function normalizeJid(input: string): string {
    if (input.includes('@')) {
        const parsed = parseJid(input);
        if (parsed === null) throw invalidJid(input);
        return `${parsed.user}@${parsed.server}`;
    }

    return `${normalizePhoneNumber(input)}@${DEFAULT_SERVER}`;
}
