// @ts-check
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  // Block 1: Global ignores
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'src-tauri/target/**',
      '.agent/**',
      'src/workers/ml.worker.ts',
      'src/generated/**',
      'convex/**',
      'api/\\[domain\\]/**', // esbuild artifact — not source; brackets escaped to prevent glob char-class interpretation
    ],
  },

  // Block 2: TypeScript source — full type-checked rules
  {
    files: ['src/**/*.ts'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    plugins: {
      unicorn,
      sonarjs,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/localhost/]',
          message: 'Use 127.0.0.1 instead of localhost — WKWebView treats them as distinct origins.',
        },
      ],
      ...unicorn.configs.recommended.rules,
      ...sonarjs.configs.recommended.rules,
      // Unicorn overrides — codebase conventions
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/filename-case': 'off',
      // ES version / type-safety overrides (unsafe to auto-fix with TS6)
      'unicorn/prefer-query-selector': 'off',           // querySelector returns Element, not HTMLElement
      'unicorn/prefer-string-replace-all': 'off',       // replaceAll requires ES2021
      'unicorn/prefer-at': 'off',                       // .at() requires ES2022
      'unicorn/prefer-dom-node-dataset': 'off',         // dataset missing on Element, only on HTMLElement
      'unicorn/prefer-native-coercion-functions': 'off', // strips TS type-guard predicates in .filter()
      'unicorn/prefer-switch': 'off',                   // introduces case values absent from union types
      'unicorn/prefer-array-find': 'off',               // checkFromLast introduces findLast (ES2023)
      'unicorn/explicit-length-check': 'off',           // > 0 breaks string-length truthiness checks
      'unicorn/no-useless-undefined': 'off',            // removes .reduce() initial value, breaking TS inference
      'unicorn/prefer-global-this': 'off',              // globalThis lacks window index signature for YT API
      'unicorn/no-array-for-each': 'off',               // for..of on optional-chained NodeList → TS undefined error
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // removes Element→HTMLElement casts downstream code requires
      '@typescript-eslint/non-nullable-type-assertion-style': 'off', // converts `as T` to `!`, losing type narrowing
      'unicorn/no-null': 'off',                                 // codebase convention: null used for nullable DOM/library values
      'unicorn/no-array-sort': 'off',                           // Array#toSorted requires ES2022; tsconfig targets ES2020
    },
  },

  // Block 3: Sidecar + scripts — no type-checking
  {
    files: [
      'src-tauri/sidecar/**/*.mjs',
      'scripts/**/*.mjs',
      'api/**/*.js',
    ],
    extends: [
      ...tseslint.configs.recommended,
    ],
    plugins: {
      unicorn,
      sonarjs,
    },
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/localhost/]',
          message: 'Use 127.0.0.1 instead of localhost — WKWebView treats them as distinct origins.',
        },
      ],
      ...unicorn.configs.recommended.rules,
      ...sonarjs.configs.recommended.rules,
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/filename-case': 'off',
      'unicorn/prefer-string-replace-all': 'off',       // replaceAll requires ES2021
      'unicorn/prefer-at': 'off',                       // .at() requires ES2022
      'unicorn/prefer-array-find': 'off',               // findLast requires ES2023
      'unicorn/prefer-switch': 'off',                   // can expose invalid case values
      'unicorn/explicit-length-check': 'off',           // > 0 breaks truthiness checks on non-number types
      'unicorn/no-useless-undefined': 'off',            // removes .reduce() initial value
      'unicorn/no-null': 'off',                         // codebase convention: null used for nullable values
      'unicorn/no-array-sort': 'off',                   // Array#toSorted requires ES2022
    },
  },

  // Block 4: Test files — relaxed rules
  {
    files: ['**/*.test.*', 'e2e/**'],
    rules: {
      'no-console': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'unicorn/no-process-exit': 'off',
    },
  },
);
