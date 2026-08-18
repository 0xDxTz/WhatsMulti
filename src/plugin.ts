import type { ResolvedConfig } from './config.js';
import { describeError, WhatsMultiError } from './errors.js';
import type { WMEventEmitter } from './events/emitter.js';
import type { Logger } from './logger.js';

/**
 * Plugins are how the webhook forwarder, the REST server and anything else stay out
 * of core while still being first-class. Core keeps zero runtime dependencies
 * because none of them are core.
 */

/** The subset of the event bus a plugin may touch: subscribe, never emit. */
export type PluginEvents = Pick<WMEventEmitter, 'on' | 'once' | 'off' | 'process'>;

export interface PluginContext {
    readonly instanceId: string;
    readonly config: ResolvedConfig;
    readonly logger: Logger;
    readonly events: PluginEvents;
}

export interface Plugin {
    readonly name: string;
    /**
     * Returns `unknown` rather than `void | Promise<void>` so that a concise arrow
     * body -- `(ctx) => ctx.events.on('qr', handle)` -- typechecks. The union form
     * loses TypeScript's void-return exemption and rejects it.
     */
    setup(context: PluginContext): unknown;
    dispose?(): unknown;
}

export class PluginRegistry {
    readonly #plugins = new Map<string, Plugin>();
    #started = false;

    get size(): number {
        return this.#plugins.size;
    }

    names(): string[] {
        return [...this.#plugins.keys()];
    }

    has(name: string): boolean {
        return this.#plugins.has(name);
    }

    register(plugin: Plugin): void {
        if (typeof plugin.name !== 'string' || plugin.name.length === 0) {
            throw new WhatsMultiError('INVALID_CONFIG', {
                params: { path: 'plugin.name', detail: 'a plugin must have a non-empty name' },
            });
        }
        if (this.#plugins.has(plugin.name)) {
            throw new WhatsMultiError('INVALID_CONFIG', {
                params: { path: 'plugin.name', detail: `plugin "${plugin.name}" is already registered` },
            });
        }
        if (this.#started) {
            throw new WhatsMultiError('INVALID_CONFIG', {
                params: { path: 'plugin', detail: 'plugins must be registered before the client starts' },
            });
        }
        this.#plugins.set(plugin.name, plugin);
    }

    /** Sequential on purpose: a later plugin may depend on an earlier one's wiring. */
    async setup(context: PluginContext): Promise<void> {
        this.#started = true;
        for (const plugin of this.#plugins.values()) {
            await plugin.setup({ ...context, logger: context.logger.child({ plugin: plugin.name }) });
        }
    }

    /**
     * Every plugin gets disposed even when one fails, in reverse registration order.
     * Failures are collected and reported together -- a leaked webhook queue is worse
     * than a noisy shutdown.
     */
    async dispose(logger: Logger): Promise<void> {
        const failures: string[] = [];

        for (const plugin of [...this.#plugins.values()].reverse()) {
            try {
                await plugin.dispose?.();
            } catch (error) {
                logger.error({ err: error, plugin: plugin.name }, 'plugin dispose failed');
                failures.push(`${plugin.name}: ${describeError(error)}`);
            }
        }

        this.#plugins.clear();
        this.#started = false;

        if (failures.length > 0) {
            throw new WhatsMultiError('INVALID_CONFIG', {
                params: { path: 'plugin.dispose', detail: failures.join('; ') },
            });
        }
    }
}

/** Helper so a plugin can be written as a plain function. */
export function definePlugin(name: string, setup: Plugin['setup'], dispose?: Plugin['dispose']): Plugin {
    return dispose === undefined ? { name, setup } : { name, setup, dispose };
}
