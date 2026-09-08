// Rules that catch what review keeps having to catch by eye. Deliberately not a
// style guide: the formatting here is consistent already, and a linter arguing
// about it would only add noise to a diff.
//
//   npm run lint

import js from '@eslint/js';

// `chrome` is the extension API, present in every context the extension runs
// in. The tests stand up their own on globalThis.
const EXTENSION_GLOBALS = {
  chrome: 'readonly'
};

const BROWSER_GLOBALS = {
  document: 'readonly',
  window: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  fetch: 'readonly',
  Image: 'readonly',
  DOMParser: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  IntersectionObserver: 'readonly',
  structuredClone: 'readonly',
  globalThis: 'readonly'
};

const shared = {
  ...js.configs.recommended.rules,
  // An unused argument is often a signature being honoured; an unused variable
  // is not.
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^unused' }],
  // An empty catch is how "this failure is not worth reporting" is spelled all
  // over this codebase, and every one of them carries a comment saying so.
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': 'error',
  'no-implicit-coercion': 'error',
  // Nothing here builds markup from a string, and the CSP would refuse most of
  // what could be smuggled in this way. Keep it that way.
  'no-eval': 'error',
  'no-implied-eval': 'error'
};

export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...EXTENSION_GLOBALS, ...BROWSER_GLOBALS }
    },
    rules: shared
  },
  {
    // The service worker has no DOM: nothing here may reach for one.
    files: ['background.js'],
    languageOptions: {
      globals: { ...EXTENSION_GLOBALS, fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly' }
    },
    rules: {
      ...shared,
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'A service worker has no DOM.' },
        { name: 'DOMParser', message: 'A service worker has no DOMParser. JSON needs none.' }
      ]
    }
  },
  {
    files: ['test/**'],
    languageOptions: { globals: { ...BROWSER_GLOBALS, chrome: 'writable', process: 'readonly' } },
    rules: shared
  },
  { ignores: ['node_modules/'] }
];
