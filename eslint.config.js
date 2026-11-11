import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

const root = dirname(fileURLToPath(import.meta.url));
const architecture = {
    rules: {
        imports: {
            meta: {
                type: 'problem',
                schema: [],
                messages: { direction: '{{from}} may not import {{to}}; use a feature interface or host adapter.' },
            },
            create(context) {
                const from = relative(root, context.filename).split(sep).join('/');
                function check(node) {
                    const specifier = node.source?.value;
                    if (typeof specifier !== 'string') {
                        return;
                    }
                    const to = specifier.startsWith('.')
                        ? relative(root, resolve(dirname(context.filename), specifier)).split(sep).join('/')
                        : specifier;
                    const forbidden = !specifier.startsWith('.')
                        || (to.startsWith('../') && !from.startsWith('src/platform/'))
                        || to.includes('.workbuddy/')
                        || (/^src\/(core|shared)\//.test(from) && /^src\/(features|platform|ui|app)\//.test(to))
                        || (from.startsWith('src/features/') && to.startsWith('src/ui/'))
                        || (from.startsWith('src/platform/') && /^src\/(features|ui|app)\//.test(to));
                    if (forbidden) {
                        context.report({ node, messageId: 'direction', data: { from, to } });
                    }
                }
                return { ImportDeclaration: check, ExportNamedDeclaration: check, ExportAllDeclaration: check, ImportExpression: check };
            },
        },
    },
};

export default defineConfig([
    {
        ignores: ['.git/**', '.workbuddy/**', '.test-sandbox/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**'],
    },
    {
        files: ['**/*.js', '**/*.mjs'],
        extends: [js.configs.recommended],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.node, jQuery: 'readonly', toastr: 'readonly' },
        },
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-constant-binary-expression': 'error',
            'semi': ['error', 'always'],
            'quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
            'comma-dangle': ['error', 'always-multiline'],
        },
    },
    {
        files: ['src/**/*.js', 'index.js'],
        plugins: { thrive: architecture },
        rules: { 'thrive/imports': 'error' },
    },
]);
