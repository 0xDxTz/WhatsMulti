import { afterEach, describe, expect, it, vi } from 'vitest';

import { isWhatsMultiError } from '../../src/errors.js';
import { loadQrRenderer, printQr, setQrLoader, toBuffer, toDataURL, toSvg, toTerminal } from '../../src/qr/index.js';

const QR = '2@abcdefghijklmnopqrstuvwxyz,0123456789';

afterEach(() => {
    setQrLoader(null);
});

/**
 * Run against the real `qrcode`, not a stub: the whole point of this module is that
 * the option shapes it passes are the ones the renderer accepts, and a stub would
 * agree with whatever we wrote.
 */
describe('rendering', () => {
    it('renders a terminal block', async () => {
        const art = await toTerminal(QR);
        expect(art).toContain('█');
        expect(art.split('\n').length).toBeGreaterThan(10);
    });

    it('defaults to the half-height form, which the renderer does not', async () => {
        const small = (await toTerminal(QR)).split('\n').length;
        const full = (await toTerminal(QR, { small: false })).split('\n').length;
        expect(small).toBeLessThan(full);
    });

    it('renders a PNG data URL', async () => {
        await expect(toDataURL(QR)).resolves.toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    });

    it('renders PNG bytes', async () => {
        const png = await toBuffer(QR);
        expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it('renders SVG', async () => {
        await expect(toSvg(QR)).resolves.toContain('<svg');
    });

    it('honours render options', async () => {
        const tight = await toBuffer(QR, { margin: 0, scale: 1 });
        const loose = await toBuffer(QR, { margin: 8, scale: 8 });
        expect(loose.byteLength).toBeGreaterThan(tight.byteLength);
    });
});

describe('printQr', () => {
    it('writes to the injected sink, padded so it is not glued to other output', async () => {
        const chunks: string[] = [];
        await printQr(QR, { write: (chunk) => chunks.push(chunk) });

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.startsWith('\n')).toBe(true);
        expect(chunks[0]?.endsWith('\n')).toBe(true);
        expect(chunks[0]).toContain('█');
    });

    it('does not pass the sink through to the renderer', async () => {
        const toString = vi.fn(() => Promise.resolve('art'));
        setQrLoader(() => Promise.resolve({ toString, toDataURL: () => {}, toBuffer: () => {} }));

        await printQr(QR, { write: () => {}, margin: 2 });

        expect(toString).toHaveBeenCalledWith(QR, { small: true, margin: 2, type: 'terminal' });
    });
});

describe('the optional peer', () => {
    it('reports a missing renderer with the command that fixes it', async () => {
        setQrLoader(() => Promise.reject(new Error("Cannot find module 'qrcode'")));

        const error = await toTerminal(QR).catch((cause: unknown) => cause);
        expect(isWhatsMultiError(error)).toBe(true);
        expect(error).toMatchObject({ code: 'MISSING_PEER' });
        expect((error as Error).message).toContain('npm install qrcode');
    });

    it('does not cache the failure, so installing it later is enough', async () => {
        setQrLoader(() => Promise.reject(new Error('nope')));
        await expect(loadQrRenderer()).rejects.toMatchObject({ code: 'MISSING_PEER' });

        setQrLoader(null);
        await expect(toTerminal(QR)).resolves.toContain('█');
    });

    it('accepts the CommonJS shape, where the module arrives under default', async () => {
        const api = { toString: () => Promise.resolve('art'), toDataURL: () => {}, toBuffer: () => {} };
        setQrLoader(() => Promise.resolve({ default: api }));

        await expect(toTerminal(QR)).resolves.toBe('art');
    });

    it('rejects a module that is not a renderer rather than failing inside a call', async () => {
        setQrLoader(() => Promise.resolve({ nothing: true }));
        await expect(loadQrRenderer()).rejects.toMatchObject({ code: 'MISSING_PEER' });
    });

    it('loads once and reuses it', async () => {
        const loader = vi.fn(() =>
            Promise.resolve({ toString: () => Promise.resolve('art'), toDataURL: () => {}, toBuffer: () => {} })
        );
        setQrLoader(loader);

        await toTerminal(QR);
        await toTerminal(QR);

        expect(loader).toHaveBeenCalledTimes(1);
    });
});
