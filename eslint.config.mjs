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
export const LAYERS = {
    'src/storage/**': ['session', 'messaging', 'events', 'auth', 'plugin', 'client', 'compat'],
    'src/auth/**': ['session', 'messaging', 'plugin', 'client'],
    'src/events/**': ['session', 'storage', 'auth', 'messaging', 'client'],
    'src/messaging/**': ['client', 'session', 'storage'],
    // Adapters implement the storage and lock contracts and nothing else. One that
    // could reach the session layer would be a backend with opinions about sessions.
    'src/adapters/**': ['client', 'session', 'messaging', 'events', 'plugin', 'auth', 'compat', 'qr'],
    // The QR entry point is a leaf: it renders a string and knows nothing else.
    'src/qr/**': ['client', 'session', 'storage', 'auth', 'messaging', 'events', 'plugin', 'compat'],
    'src/utils/**': ['session', 'storage', 'auth', 'messaging', 'events', 'plugin', 'client', 'compat'],
    // The lock contract is a leaf, like storage: adapters implement it, and it must
    // not reach back into the session layer that consumes it.
    'src/lock.ts': ['session', 'storage', 'auth', 'messaging', 'events', 'plugin', 'client', 'compat'],
};

/**
 * Generated files are pure constants compiled from spec/ and import nothing outside
 * their own directory -- that self-containment is what makes them safe to regenerate.
 * Expressed as a path restriction rather than a layer list so that the barrel can
 * still re-export its own siblings.
 */
const GENERATED_CONFIG = {
    files: ['src/generated/**'],
    rules: {
        'no-restricted-imports': ['error', { patterns: ['../*', '../**'] }],
    },
};

export const layerConfigs = Object.entries(LAYERS).map(([files, forbidden]) => ({
    files: [files],
    rules: {
        'no-restricted-imports': [
            'error',
            {
                // Imports carry an explicit .js extension under nodenext, so a bare
                // `**/plugin` pattern silently matches nothing. test/unit/layering
                // asserts these actually fire.
                patterns: forbidden.flatMap((dir) => [`**/${dir}`, `**/${dir}.js`, `**/${dir}/**`, `**/${dir}/*.js`]),
            },
        ],
    },
}));

layerConfigs.push(GENERATED_CONFIG);

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

            // An adapter method that satisfies a Promise-returning contract without
            // awaiting anything is correct, not a mistake: declaring it async is what
            // turns a synchronous throw into a rejection the caller can catch.
            '@typescript-eslint/require-await': 'off',
        },
    },
    ...layerConfigs,
    {
        // Rewritten by scripts/generate.mjs; never hand-edited.
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
