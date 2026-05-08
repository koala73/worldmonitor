#!/usr/bin/env node
// Splits src/locales/en.json into a small "shell" subset that the i18n
// service statically imports (kept in the main JS chunk) and a larger
// "rest" subset that loads as a separate lazy chunk during initI18n().
//
// Source of truth: src/locales/en.json (devs edit here, in one place).
// Outputs:
//   - src/locales/en.shell.json  (~25KB; kept in main bundle)
//   - src/locales/en.rest.json   (~90KB; lazy-loaded)
//
// Run via `npm run build:i18n-shell`. Wired into `prebuild` so the split
// is regenerated before every `vite build`. A parity test in
// tests/i18n-shell-split.test.mts asserts merged(shell, rest) === en.json
// to block drift if the committed split diverges from en.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const SRC = resolve(ROOT, 'src/locales/en.json');
const SHELL_OUT = resolve(ROOT, 'src/locales/en.shell.json');
const REST_OUT = resolve(ROOT, 'src/locales/en.rest.json');

// Top-level keys whose values render on the critical path: header, panel
// chrome, command palette, common toasts, app-skeleton errors, auth state,
// connectivity banners, premium gates, region selector. Anything not in
// this set falls into `rest` and is lazy-loaded.
const SHELL_TOP_LEVEL = new Set([
  'app',
  'auth',
  'common',
  'connectivity',
  'contextMenu',
  'header',
  'panels',
  'widgets',
  'premium',
  'preferences',
  'alerts',
  'commands',
]);

// Carve-outs from `components`: subkeys used by chrome (Panel base class
// add/close/expand buttons, region picker labels, map show/hide toggle).
// Everything else under `components` is per-panel content, lazy-loaded.
const SHELL_COMPONENTS_SUBKEYS = new Set(['panel', 'deckgl', 'map']);

function partition(en) {
  const shell = {};
  const rest = {};
  for (const [topKey, topValue] of Object.entries(en)) {
    if (SHELL_TOP_LEVEL.has(topKey)) {
      shell[topKey] = topValue;
      continue;
    }
    if (topKey === 'components' && topValue && typeof topValue === 'object') {
      const shellComponents = {};
      const restComponents = {};
      for (const [subKey, subValue] of Object.entries(topValue)) {
        if (SHELL_COMPONENTS_SUBKEYS.has(subKey)) {
          shellComponents[subKey] = subValue;
        } else {
          restComponents[subKey] = subValue;
        }
      }
      if (Object.keys(shellComponents).length > 0) shell.components = shellComponents;
      if (Object.keys(restComponents).length > 0) rest.components = restComponents;
      continue;
    }
    rest[topKey] = topValue;
  }
  return { shell, rest };
}

function writeJson(path, data) {
  // 2-space pretty for diff-friendliness; trailing newline matches the
  // editorconfig + git's auto-newline behavior on the source en.json.
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function main() {
  const enRaw = readFileSync(SRC, 'utf8');
  const en = JSON.parse(enRaw);
  const { shell, rest } = partition(en);
  writeJson(SHELL_OUT, shell);
  writeJson(REST_OUT, rest);

  const shellBytes = Buffer.byteLength(JSON.stringify(shell), 'utf8');
  const restBytes = Buffer.byteLength(JSON.stringify(rest), 'utf8');
  const totalBytes = Buffer.byteLength(JSON.stringify(en), 'utf8');
  const pct = (n) => ((n / totalBytes) * 100).toFixed(1);
  console.log(`[i18n-shell] en.shell.json: ${shellBytes} bytes (${pct(shellBytes)}%)`);
  console.log(`[i18n-shell] en.rest.json:  ${restBytes} bytes (${pct(restBytes)}%)`);
  console.log(`[i18n-shell] en.json total: ${totalBytes} bytes`);
}

// Only run when invoked as a CLI (npm run build:i18n-shell). Tests
// import this module for `partition()` and would otherwise re-emit the
// JSON files + log lines on every test run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { partition, SHELL_TOP_LEVEL, SHELL_COMPONENTS_SUBKEYS };
