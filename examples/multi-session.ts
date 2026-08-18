/**
 * Several accounts in one process: restoring what is already stored, adding a new
 * one, and keeping one account's credentials somewhere else.
 *
 * Run: npx tsx examples/multi-session.ts
 */
import { WhatsMulti, fileStorage } from '@dutakey/whatsmulti';

const client = new WhatsMulti({
    storage: fileStorage({ path: './data/sessions' }),
    // Registering N sessions at boot fans out with a bounded pool rather than an
    // unbounded Promise.all, which is what v1 did to a cold database.
    load: { concurrency: 8, autoStart: true },
});

client.on('session.state', ({ to }, { sessionId }) => console.log(`[${sessionId}] ${to}`));

// Ids present in storage, including sessions this process has never opened.
console.log('stored:', await client.discover());

// Registers every stored session. With load.autoStart they are started too.
const restored = await client.load();
console.log(`restored ${restored.length}`);

// A new one, and a second whose credentials live on separate storage -- one process
// can keep different accounts in different places.
await client.ensureSession('support');
await client.createSession('archive', { storage: fileStorage({ path: '/mnt/cold/wa' }) });
await client.start('support');

for (const id of client.ids()) {
    const meta = await client.meta(id);
    console.log(id, client.session(id).state, meta?.storage, `queue=${client.session(id).queueSize}`);
}

process.on('SIGINT', () => void client.destroy().then(() => process.exit(0)));
