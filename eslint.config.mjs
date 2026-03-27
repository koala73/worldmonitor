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
          selector: "Literal[value=/localhost/]",
          message: "Use 127.0.0.1 instead of localhost — WKWebView treats them as distinct origins.",
        },
      ],
      ...unicorn.configs.recommended.rules,
      ...sonarjs.configs.recommended.rules,
      // Unicorn overrides
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/filename-case': 'off',
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
          selector: "Literal[value=/localhost/]",
          message: "Use 127.0.0.1 instead of localhost — WKWebView treats them as distinct origins.",
        },
      ],
      ...unicorn.configs.recommended.rules,
      ...sonarjs.configs.recommended.rules,
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/filename-case': 'off',
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
