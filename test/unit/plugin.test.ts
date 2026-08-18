import { describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../../src/config.js';
import { WMEventEmitter } from '../../src/events/emitter.js';
import { createLogger, silentLogger } from '../../src/logger.js';
import { definePlugin, PluginRegistry, type PluginContext } from '../../src/plugin.js';

const context = (): PluginContext => {
    const events = new WMEventEmitter();
    return {
        instanceId: 'host:1:abc',
        config: resolveConfig({ instanceId: 'host:1:abc' }),
        logger: silentLogger,
        events,
    };
};

describe('registration', () => {
    it('registers and lists plugins', () => {
        const registry = new PluginRegistry();
        registry.register(definePlugin('a', () => {}));
        registry.register(definePlugin('b', () => {}));

        expect(registry.size).toBe(2);
        expect(registry.names()).toEqual(['a', 'b']);
        expect(registry.has('a')).toBe(true);
        expect(registry.has('c')).toBe(false);
    });

    it('rejects a duplicate name', () => {
        const registry = new PluginRegistry();
        registry.register(definePlugin('a', () => {}));
        expect(() => registry.register(definePlugin('a', () => {}))).toThrowError(/already registered/);
    });

    it('rejects an unnamed plugin', () => {
        const registry = new PluginRegistry();
        expect(() => registry.register({ name: '', setup: () => {} })).toThrowError(/non-empty name/);
    });

    it('rejects registration after setup, when the wiring is already live', () => {
        const registry = new PluginRegistry();
        return registry.setup(context()).then(() => {
            expect(() => registry.register(definePlugin('late', () => {}))).toThrowError(/before the client starts/);
        });
    });
});

describe('setup', () => {
    it('runs plugins in registration order', async () => {
        const order: string[] = [];
        const registry = new PluginRegistry();
        registry.register(definePlugin('first', () => void order.push('first')));
        registry.register(definePlugin('second', () => void order.push('second')));

        await registry.setup(context());
        expect(order).toEqual(['first', 'second']);
    });

    it('awaits an async setup before starting the next plugin', async () => {
        const order: string[] = [];
        const registry = new PluginRegistry();

        registry.register(
            definePlugin('slow', async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                order.push('slow');
            })
        );
        registry.register(definePlugin('fast', () => void order.push('fast')));

        await registry.setup(context());
        expect(order).toEqual(['slow', 'fast']);
    });

    it('gives each plugin a logger bound to its name', async () => {
        const lines: string[] = [];
        const registry = new PluginRegistry();
        registry.register(definePlugin('webhook', (ctx) => ctx.logger.error('hello')));

        await registry.setup({
            ...context(),
            logger: createLogger({ level: 'error', write: (line) => void lines.push(line) }),
        });

        expect(lines[0]).toContain('"plugin":"webhook"');
    });

    it('lets a plugin subscribe to events', async () => {
        const seen = vi.fn();
        const ctx = context();
        const registry = new PluginRegistry();
        registry.register(definePlugin('listener', (c) => c.events.on('session.fenced', seen)));

        await registry.setup(ctx);
        (ctx.events as WMEventEmitter).emit(
            'session.fenced',
            { owner: 'x' },
            { sessionId: 'a', instanceId: 'i', ts: 0 }
        );

        expect(seen).toHaveBeenCalledOnce();
    });

    it('propagates a setup failure to the caller', async () => {
        const registry = new PluginRegistry();
        registry.register(
            definePlugin('broken', () => {
                throw new Error('setup failed');
            })
        );
        await expect(registry.setup(context())).rejects.toThrowError('setup failed');
    });
});

describe('dispose', () => {
    it('disposes in reverse order and empties the registry', async () => {
        const order: string[] = [];
        const registry = new PluginRegistry();
        registry.register(
            definePlugin(
                'first',
                () => {},
                () => void order.push('first')
            )
        );
        registry.register(
            definePlugin(
                'second',
                () => {},
                () => void order.push('second')
            )
        );

        await registry.setup(context());
        await registry.dispose(silentLogger);

        expect(order).toEqual(['second', 'first']);
        expect(registry.size).toBe(0);
    });

    it('tolerates a plugin with no dispose hook', async () => {
        const registry = new PluginRegistry();
        registry.register(definePlugin('a', () => {}));
        await registry.setup(context());
        await expect(registry.dispose(silentLogger)).resolves.toBeUndefined();
    });

    it('disposes every plugin even when one fails, then reports the failures', async () => {
        // A leaked webhook queue is worse than a noisy shutdown, so one bad plugin
        // must not skip the rest.
        const disposed: string[] = [];
        const registry = new PluginRegistry();

        registry.register(
            definePlugin(
                'ok',
                () => {},
                () => void disposed.push('ok')
            )
        );
        registry.register(
            definePlugin(
                'bad',
                () => {},
                () => {
                    throw new Error('dispose failed');
                }
            )
        );

        await registry.setup(context());
        await expect(registry.dispose(silentLogger)).rejects.toThrowError(/bad: dispose failed/);
        expect(disposed).toEqual(['ok']);
        expect(registry.size).toBe(0);
    });

    it('allows re-registration after a dispose', async () => {
        const registry = new PluginRegistry();
        registry.register(definePlugin('a', () => {}));
        await registry.setup(context());
        await registry.dispose(silentLogger);

        expect(() => registry.register(definePlugin('a', () => {}))).not.toThrow();
    });
});

describe('definePlugin', () => {
    it('omits dispose when none is given', () => {
        expect('dispose' in definePlugin('a', () => {})).toBe(false);
        expect(
            'dispose' in
                definePlugin(
                    'a',
                    () => {},
                    () => {}
                )
        ).toBe(true);
    });
});
