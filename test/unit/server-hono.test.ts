import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadHono, setHonoLoader, type HonoRuntime } from '../../src/server/hono.js';

afterEach(() => {
    setHonoLoader(null);
});

describe('loadHono', () => {
    it('loads the real peer', async () => {
        const { Hono, streamSSE } = await loadHono();
        expect(typeof Hono).toBe('function');
        expect(typeof streamSSE).toBe('function');
    });

    it('memoises the module', async () => {
        const runtime = { Hono: class {}, streamSSE: () => undefined } as unknown as HonoRuntime;
        const loader = vi.fn(() => Promise.resolve(runtime));
        setHonoLoader(loader);

        expect(await loadHono()).toBe(runtime);
        expect(await loadHono()).toBe(runtime);
        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('reports a missing peer by name, with the install command', async () => {
        setHonoLoader(() => Promise.reject(new Error('ERR_MODULE_NOT_FOUND')));

        await expect(loadHono()).rejects.toThrow(expect.objectContaining({ code: 'MISSING_PEER' }) as Error);
        await expect(loadHono()).rejects.toThrow('npm install hono');
    });

    it('does not memoise a failure', async () => {
        // Installing the peer and retrying inside a long-lived process has to work,
        // rather than failing forever against a cached rejection.
        const runtime = { Hono: class {}, streamSSE: () => undefined } as unknown as HonoRuntime;
        let attempt = 0;
        setHonoLoader(() => {
            attempt += 1;
            return attempt === 1 ? Promise.reject(new Error('not installed')) : Promise.resolve(runtime);
        });

        await expect(loadHono()).rejects.toThrow();
        expect(await loadHono()).toBe(runtime);
    });

    it('restores the default loader', async () => {
        setHonoLoader(() => Promise.reject(new Error('stubbed')));
        setHonoLoader(null);
        expect(typeof (await loadHono()).Hono).toBe('function');
    });
});
