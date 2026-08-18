import type { Linter } from 'eslint';

/** Directory glob -> the layer names it may not import. */
export declare const LAYERS: Record<string, string[]>;

/** One flat-config entry per layer, carrying the generated no-restricted-imports patterns. */
export declare const layerConfigs: Linter.Config[];

declare const config: Linter.Config[];
export default config;
