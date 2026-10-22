import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.output/**',
      '.output-*/**',
      '.wxt/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.claude/**',
      '.codex/**',
      '.agents/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Security guardrails (docs/architecture.md §10, D-10): model and page
      // text are untrusted and must only ever be rendered as text.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Render untrusted text as text nodes, never as HTML (D-10).',
        },
        {
          selector:
            'AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]',
          message: 'Do not assign HTML strings; build DOM nodes or use textContent.',
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'Do not insert HTML strings; build DOM nodes or use textContent.',
        },
      ],
      // Logging selected text or keys is forbidden (FR-073); use the redacting logger.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Extension code runs in the browser. WXT/Vite types make Node globals
    // visible to tsc, so block them here instead.
    files: ['entrypoints/**', 'lib/**', 'components/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['process', 'Buffer', 'require', 'module', '__dirname', '__filename', 'global'].map(
          (name) => ({ name, message: 'Node globals are not available in the extension.' }),
        ),
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'Node modules are not available in the extension.' },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}', '*.config.ts', 'scripts/**', 'tests/**'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Playwright fixtures use a callback named `use`, which is not a React hook.
    files: ['tests/e2e/**', 'playwright.config.ts'],
    rules: {
      'react-hooks/rules-of-hooks': 'off',
    },
  },
);
