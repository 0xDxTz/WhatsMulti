import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadDriver, setDriverLoader, type BaileysModule } from '../../src/compat/driver.js';
import { WhatsMultiError } from '../../src/errors.js';

afterEach(() => {
    setDriverLoader(null);
});

type DriverLoaderFn = () => Promise<BaileysModule>;

const stub = (): BaileysModule => ({ initAuthCreds: () => ({}) }) as unknown as BaileysModule;

describe('loadDriver', () => {
    it('loads the real Baileys module by default', async () => {
        const driver = await loadDriver();

        expect(typeof driver.initAuthCreds).toBe('function');
        expect(typeof driver.proto).toBe('object');
    });

    it('memoises the module so repeated calls do not reload it', async () => {
        const load = vi.fn(() => Promise.resolve(stub()));
        setDriverLoader(load);

        const [first, second] = await Promise.all([loadDriver(), loadDriver()]);

        expect(first).toBe(second);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('reports a missing peer as MISSING_PEER, naming the install command', async () => {
        const cause = new Error("Cannot find package '@whiskeysockets/baileys'");
        setDriverLoader(() => Promise.reject(cause));

        const error = await loadDriver().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(WhatsMultiError);
        expect((error as WhatsMultiError).code).toBe('MISSING_PEER');
        expect((error as WhatsMultiError).message).toContain('npm install @whiskeysockets/baileys');
        expect((error as WhatsMultiError).cause).toBe(cause);
    });

    it('does not memoise a failure, so a retry after installing the peer succeeds', async () => {
        const load = vi
            .fn<DriverLoaderFn>()
            .mockRejectedValueOnce(new Error('not installed'))
            .mockResolvedValueOnce(stub());
        setDriverLoader(load);

        await expect(loadDriver()).rejects.toBeInstanceOf(WhatsMultiError);
        await expect(loadDriver()).resolves.toBeDefined();
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('restores the built-in loader when reset with null', async () => {
        setDriverLoader(() => Promise.resolve(stub()));
        setDriverLoader(null);

        await expect(loadDriver()).resolves.toHaveProperty('proto');
    });
});
