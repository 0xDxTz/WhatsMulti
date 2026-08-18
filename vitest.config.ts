import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * Parity-critical modules carry no coverage slack. The threshold activates the moment
 * the file lands, so it cannot be forgotten during the phased rewrite.
 */
const strict = ['src/session/state.ts', 'src/session/disconnect.ts', 'src/session/reconnect.ts'];
const full = { lines: 100, functions: 100, branches: 100, statements: 100 };

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.d.ts', 'src/types/**'],
            reporter: ['text', 'lcov'],
            thresholds: {
                lines: 80,
                functions: 80,
                branches: 75,
                statements: 80,
                ...Object.fromEntries(strict.filter((f) => existsSync(f)).map((f) => [f, full])),
            },
        },
    },
});
