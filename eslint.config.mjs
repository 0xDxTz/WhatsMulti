import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Layering. Dependencies point downward only:
 *
 *   client -> session -> auth -> storage
 *          -> messaging
 *          -> events
 *   generated / utils / types depend on nothing above them.
 *
 * Without this rule the layering is a convention, and conventions rot. v1's
 * module-global stores are what happens when nothing enforces direction.
 */
const layers = {
    'src/storage/**': ['session', 'messaging', 'events', 'auth', 'plugin', 'client', 'compat'],
    'src/auth/**': ['session', 'messaging', 'plugin', 'client'],
    'src/events/**': ['session', 'storage', 'auth', 'messaging', 'client'],
    'src/messaging/**': ['client', 'storage'],
    'src/utils/**': ['session', 'storage', 'auth', 'messaging', 'events', 'plugin', 'client', 'compat'],
    'src/generated/**': ['session', 'storage', 'auth', 'messaging', 'events', 'plugin', 'client', 'compat', 'utils'],
};

const layerConfigs = Object.entries(layers).map(([files, forbidden]) => ({
    files: [files],
    rules: {
        'no-restricted-imports': [
            'error',
            {
                patterns: forbidden.flatMap((dir) => [`**/${dir}`, `**/${dir}/**`]),
            },
        ],
    },
}));

export default tseslint.config(
    {
        ignores: ['dist/**', 'lib/**', 'node_modules/**', 'legacy/**', 'landing/**', 'coverage/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            globals: { ...globals.node },
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/switch-exhaustiveness-check': 'error',
            eqeqeq: ['error', 'always'],
            'no-console': 'error',
        },
    },
    ...layerConfigs,
    {
        // Generated files are rewritten by scripts/generate.mjs; never hand-edited.
        files: ['src/generated/**'],
        rules: { '@typescript-eslint/no-redundant-type-constituents': 'off' },
    },
    {
        files: ['scripts/**/*.mjs', '*.mjs'],
        extends: [tseslint.configs.disableTypeChecked],
        rules: { 'no-console': 'off' },
    },
    {
        files: ['test/**/*.ts'],
        rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
    }
);
