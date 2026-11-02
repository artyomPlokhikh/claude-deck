// ESLint flat config for GJS / GNOME Shell code.
import js from '@eslint/js';

const gjsGlobals = {
    ARGV: 'readonly', console: 'readonly', global: 'readonly', imports: 'readonly', log: 'readonly',
    logError: 'readonly', print: 'readonly', printerr: 'readonly', TextDecoder: 'readonly',
    TextEncoder: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
};

export default [
    js.configs.recommended,
    {
        languageOptions: {ecmaVersion: 2024, sourceType: 'module', globals: gjsGlobals},
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
            'no-empty': ['error', {allowEmptyCatch: true}],
            'prefer-const': 'error',
            'eqeqeq': ['error', 'always'],
            'no-var': 'error',
        },
    },
];
