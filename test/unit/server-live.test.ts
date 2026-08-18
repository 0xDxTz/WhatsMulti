import { afterEach, describe, expect, it } from 'vitest';

import { WhatsMulti } from '../../src/client.js';
import { LiveState } from '../../src/server/live.js';
import { memoryStorage } from '../../src/storage/memory.js';
import type { WebhookEvent } from '../../src/webhook/envelope.js';
import { fakeDriver, type FakeDriver } from '../fixtures/fake-socket.js';

let open: { client: WhatsMulti; live: LiveState }[] = [];

function harness(now: () => number = Date.now): { client: WhatsMulti; live: LiveState; driver: FakeDriver } {
    const driver = fakeDriver();
    const client = new WhatsMulti({ logLevel: 'silent', storage: memoryStorage(), socketFactory: driver.factory });
    const live = new LiveState(client, now);
    open.push({ client, live });
    return { client, live, driver };
}

afterEach(async () => {
    for (const { client, live } of open) {
        live.close();
        await client.destroy();
    }
    open = [];
});

async function started(h: ReturnType<typeof harness>, id = 's1'): Promise<void> {
    await h.client.createSession(id);
    await h.client.start(id);
}

describe('the QR cache', () => {
    it('holds the outstanding code', async () => {
        const h = harness();
        await started(h);
        await h.driver.last.qr('payload');

        expect(h.live.qr('s1')).toMatchObject({ qr: 'payload', attempt: 1 });
    });

    it('keeps only the newest', async () => {
        const h = harness();
        await started(h);
        await h.driver.last.qr('first');
        await h.driver.last.qr('second');

        expect(h.live.qr('s1')?.qr).toBe('second');
    });

    it('forgets it once the session opens', async () => {
        // The phone accepted it. Handing it out afterwards sends someone to scan a
        // code that will never work again.
        const h = harness();
        await started(h);
        await h.driver.last.qr('payload');
        await h.driver.last.open();

        expect(h.live.qr('s1')).toBeUndefined();
    });

    it('forgets it when the session is removed', async () => {
        const h = harness();
        await started(h);
        await h.driver.last.qr('payload');
        await h.client.remove('s1');

        expect(h.live.qr('s1')).toBeUndefined();
    });

    it('treats an expired code as absent', async () => {
        // Checked on read rather than on a timer: a code that lapsed while nobody was
        // asking does not need waking up for.
        let clock = 1_000_000;
        const h = harness(() => clock);
        await started(h);
        await h.driver.last.qr('payload');

        const expiresAt = h.live.qr('s1')?.expiresAt ?? 0;
        clock = expiresAt + 1;
        expect(h.live.qr('s1')).toBeUndefined();
    });

    it('has nothing for a session that never produced one', () => {
        expect(harness().live.qr('unknown')).toBeUndefined();
    });
});

describe('the pairing cache', () => {
    it('holds the issued code', async () => {
        const h = harness();
        await started(h);
        await h.driver.last.qr('payload');
        await h.client.requestPairingCode('s1', '628123456789');

        expect(h.live.pairingCode('s1')).toMatchObject({ code: 'ABCD-1234', phoneNumber: '628123456789' });
    });
});

describe('subscriptions', () => {
    it('delivers canonical wire events', async () => {
        const h = harness();
        const seen: WebhookEvent[] = [];
        h.live.subscribe(
            {},
            (event) => seen.push(event),
            () => undefined
        );

        await started(h);
        await h.driver.last.deliver({ 'messages.upsert': { messages: [] } } as never);

        // Driver-native names never reach a consumer: the stream and the webhook
        // describe the same event with the same name.
        expect(seen.map((e) => e.event)).toContain('message.received');
        expect(seen.map((e) => e.event)).not.toContain('messages.upsert');
    });

    it('drops in-process-only events', async () => {
        const h = harness();
        const seen: WebhookEvent[] = [];
        h.live.subscribe(
            {},
            (event) => seen.push(event),
            () => undefined
        );

        await started(h);
        await h.driver.last.credsUpdate();

        expect(seen.map((e) => e.event)).not.toContain('creds.update');
    });

    it('filters by session and by name', async () => {
        const h = harness();
        const bySession: WebhookEvent[] = [];
        const byName: WebhookEvent[] = [];
        h.live.subscribe(
            { sessionId: 's2' },
            (e) => bySession.push(e),
            () => undefined
        );
        h.live.subscribe(
            { events: new Set(['session.state']) },
            (e) => byName.push(e),
            () => undefined
        );

        await started(h, 's1');
        await started(h, 's2');

        expect(new Set(bySession.map((e) => e.sessionId))).toEqual(new Set(['s2']));
        expect(new Set(byName.map((e) => e.event))).toEqual(new Set(['session.state']));
    });

    it('counts clients and releases them on unsubscribe', () => {
        const h = harness();
        const stop = h.live.subscribe(
            {},
            () => undefined,
            () => undefined
        );
        expect(h.live.clients).toBe(1);
        stop();
        expect(h.live.clients).toBe(0);
    });

    it('closes every client on shutdown, once', () => {
        const h = harness();
        let closed = 0;
        h.live.subscribe(
            {},
            () => undefined,
            () => (closed += 1)
        );
        h.live.subscribe(
            {},
            () => undefined,
            () => (closed += 1)
        );

        h.live.close();
        h.live.close();

        expect(closed).toBe(2);
        expect(h.live.clients).toBe(0);
    });

    it('stops listening to the client after close', async () => {
        const h = harness();
        const seen: WebhookEvent[] = [];
        h.live.subscribe(
            {},
            (event) => seen.push(event),
            () => undefined
        );
        h.live.close();

        await started(h);

        expect(seen).toEqual([]);
    });
});
