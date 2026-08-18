/**
 * What the control plane needs to know that a single request cannot ask for: the QR
 * outstanding right now, the pairing code just issued, and whoever is listening on
 * the event stream.
 *
 * All three come from one subscription to the client's event bus. Events are
 * converted to their canonical wire names on the way in, by the same code the webhook
 * forwarder uses -- an SSE frame and a webhook delivery describe the same event with
 * the same name and the same bytes, or the two are not one contract.
 */
import type { WhatsMulti } from '../client.js';
import type { PairingCodeEvent, QrEvent } from '../events/types.js';
import { toWebhookEvents, type WebhookEvent } from '../webhook/envelope.js';

export interface StreamFilter {
    readonly sessionId?: string | undefined;
    /** Canonical event names. Undefined means everything. */
    readonly events?: ReadonlySet<string> | undefined;
}

export type StreamListener = (event: WebhookEvent) => void;

interface Client {
    readonly filter: StreamFilter;
    readonly listener: StreamListener;
    readonly onClose: () => void;
}

export class LiveState {
    readonly #clients = new Set<Client>();
    readonly #qr = new Map<string, QrEvent>();
    readonly #pairing = new Map<string, PairingCodeEvent>();
    readonly #now: () => number;
    #unsubscribe: (() => void) | undefined;

    constructor(client: WhatsMulti, now: () => number = Date.now) {
        this.#now = now;
        this.#unsubscribe = client.process((batch, meta) => {
            for (const event of toWebhookEvents(batch, meta)) this.#ingest(event);
        });
    }

    /** Open event-stream connections. Reported as a metric. */
    get clients(): number {
        return this.#clients.size;
    }

    /**
     * The QR a caller could still scan, or undefined.
     *
     * Expiry is checked on read rather than by a timer: a QR that lapsed while nobody
     * was asking does not need waking up for, and a timer per session would be one
     * more thing to clear on shutdown.
     */
    qr(sessionId: string): QrEvent | undefined {
        return this.#fresh(this.#qr, sessionId);
    }

    pairingCode(sessionId: string): PairingCodeEvent | undefined {
        return this.#fresh(this.#pairing, sessionId);
    }

    subscribe(filter: StreamFilter, listener: StreamListener, onClose: () => void): () => void {
        const client: Client = { filter, listener, onClose };
        this.#clients.add(client);
        return () => this.#clients.delete(client);
    }

    /** Ends every stream and stops listening. Idempotent. */
    close(): void {
        this.#unsubscribe?.();
        this.#unsubscribe = undefined;
        for (const client of [...this.#clients]) {
            this.#clients.delete(client);
            client.onClose();
        }
        this.#qr.clear();
        this.#pairing.clear();
    }

    #fresh<T extends { expiresAt: number }>(store: Map<string, T>, sessionId: string): T | undefined {
        const held = store.get(sessionId);
        if (held === undefined) return undefined;
        if (held.expiresAt > this.#now()) return held;
        store.delete(sessionId);
        return undefined;
    }

    #ingest(event: WebhookEvent): void {
        this.#remember(event);

        for (const client of this.#clients) {
            const { filter } = client;
            if (filter.sessionId !== undefined && filter.sessionId !== event.sessionId) continue;
            if (filter.events !== undefined && !filter.events.has(event.event)) continue;
            client.listener(event);
        }
    }

    #remember(event: WebhookEvent): void {
        if (event.event === 'qr') {
            this.#qr.set(event.sessionId, event.data as QrEvent);
            return;
        }
        if (event.event === 'pairing.code') {
            this.#pairing.set(event.sessionId, event.data as PairingCodeEvent);
            return;
        }
        // A session that opened has consumed its QR, and a removed one will never
        // consume it. Serving either afterwards would send someone to scan a code the
        // phone has already accepted.
        if (event.event === 'session.removed' || (event.event === 'session.state' && this.#opened(event))) {
            this.#qr.delete(event.sessionId);
            this.#pairing.delete(event.sessionId);
        }
    }

    #opened(event: WebhookEvent): boolean {
        return (event.data as { to?: string } | null)?.to === 'open';
    }
}
