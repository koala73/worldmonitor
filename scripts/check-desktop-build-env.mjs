#!/usr/bin/env node
/**
 * Desktop build-env completeness check (#5905, part of #5902).
 *
 * Guards two invariants:
 *
 * 1. Every Tauri build step (`uses: tauri-apps/tauri-action`) in
 *    build-desktop.yml and test-linux-app.yml declares every REQUIRED
 *    `VITE_*` env key. The web app gets these from Vercel env; the desktop
 *    bundle only gets what the workflow passes, and a missing key silently
 *    disables the capability in every shipped build (sign-in, subscription
 *    Pro, the Cyber Threats layer — the #5905 incident class).
 *
 * 2. Every literal `VITE_*` property the SPA reads is classified here as
 *    REQUIRED or EXCLUDED. A new unclassified var fails this check, forcing
 *    the author to decide — and record — whether desktop builds need it,
 *    instead of silently omitting it the way the #5905 set was.
 *
 * Run: node scripts/check-desktop-build-env.mjs [--root <repo-root>]
 */

import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { isMainModule } from './lib/main-module.mjs';

// Env keys every Tauri build step must declare. Secret-sourced keys render
// empty until the repo secret exists — behavior is then unchanged from
// before this check, so declaring them is always safe; the declaration is
// what this gate can see from a PR.
export const REQUIRED_DESKTOP_BUILD_ENV = [
  'VITE_VARIANT', //            which variant bundle to build
  'VITE_DESKTOP_RUNTIME', //    marks the bundle as the Tauri runtime
  'VITE_WS_API_URL', //         cloud API origin for desktop fallback
  'VITE_CLERK_PUBLISHABLE_KEY', // sign-in; absent => auth disabled entirely
  'VITE_CONVEX_URL', //         entitlements; the non-VITE CONVEX_URL never reaches the client
  'VITE_ENABLE_CYBER_LAYER', // Cyber Threats layer; absent => hidden (#5829 half)
  'VITE_WS_RELAY_URL', //       desktop military-flights direct OpenSky path
  'VITE_PMTILES_URL_PUBLIC', // self-hosted basemap on desktop (else OpenFreeMap fallback)
];

// SPA-read VITE_ vars that desktop builds deliberately do NOT set.
// Every entry needs a reason: this map is the decision record.
export const EXCLUDED_DESKTOP_BUILD_ENV = {
  VITE_ENABLE_IRAN_ATTACKS: 'feature sunset, default-off everywhere (#4982)',
  VITE_ENABLE_AIS: "opt-out flag (only 'false' disables); unset default is enabled — correct on desktop, where AIS is gated by the aisRelay keyring feature instead",
  VITE_VAPID_PUBLIC_KEY: 'web-push is intentionally unsupported in Tauri; isWebPushSupported() excludes desktop contexts',
  VITE_OPENSKY_RELAY_URL: 'web-seeded runtime secret; desktop uses the OS-keyring path instead',
  VITE_TAURI_API_BASE_URL: 'dev-only override; default is correct in builds',
  VITE_TAURI_REMOTE_API_BASE_URL: 'dev-only override; default is correct in builds',
  VITE_SENTRY_DSN: 'desktop telemetry deliberately unset today; revisit with #1942 diagnostics',
  VITE_DODO_ENVIRONMENT: 'dormant checkout overlay; desktop checkout flow is #5911',
  VITE_PMTILES_URL: 'web proxy URL; desktop uses VITE_PMTILES_URL_PUBLIC (direct R2)',
  VITE_CLOUD_PREFS_ENABLED: 'cloud prefs sync is fully disabled on desktop (cloud-prefs-sync.ts)',
  VITE_RSS_DIRECT_TO_RELAY: 'feature flag with correct default',
  VITE_RELAY_GATES_READY: 'feature flag with correct default',
  VITE_QUIET_HOURS_BATCH_ENABLED: 'feature flag with correct default',
  VITE_DIGEST_CRON_ENABLED: 'feature flag with correct default',
  VITE_FOLLOW_COUNTRIES_ENABLED: 'feature flag with correct default',
  VITE_MAP_INTERACTION_MODE: 'optional override; default is correct',
  VITE_HORMUZ_CRISIS_START_DATE: 'editorial re-pin override; default pinned in code',
  VITE_TELEGRAM_BOT_USERNAME: "defaults to 'WorldMonitorBot' in code",
  VITE_E2E: 'test-harness flag, never set in real builds',
};

// Workflow files are discovered rather than hand-listed so a new release or
// canary workflow cannot silently escape the parity gate.
export function discoverDesktopBuildWorkflows(rootDir) {
  const workflowsDir = path.join(rootDir, '.github/workflows');
  return readdirSync(workflowsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:yml|yaml)$/.test(entry.name))
    .map((entry) => path.join('.github/workflows', entry.name))
    .filter((workflowPath) => extractTauriBuildSteps(readFileSync(path.join(rootDir, workflowPath), 'utf8')).length > 0);
}

function lineIndent(line) {
  return line.match(/^[ \t]*/)[0].length;
}

function yamlValue(value) {
  return value
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * Extract every step block using tauri-apps/tauri-action from a workflow
 * source, returning [{ name, envKeys }]. The indentation-aware parser handles
 * multiple jobs, folded values, and uses-first unnamed steps without requiring
 * npm dependencies in the install-free desktop-config CI job.
 */
export function extractTauriBuildSteps(workflowSource) {
  const lines = workflowSource.replace(/\r\n/g, '\n').split('\n');
  const steps = [];
  for (let stepsIndex = 0; stepsIndex < lines.length; stepsIndex++) {
    const stepsMatch = lines[stepsIndex].match(/^(\s*)steps:\s*(?:#.*)?$/);
    if (!stepsMatch) continue;
    const stepsIndent = stepsMatch[1].length;
    let blockEnd = lines.length;
    let itemIndent = null;
    for (let index = stepsIndex + 1; index < lines.length; index++) {
      const line = lines[index];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = lineIndent(line);
      if (indent < stepsIndent || (indent === stepsIndent && !trimmed.startsWith('-'))) {
        blockEnd = index;
        break;
      }
      if (itemIndent === null && indent >= stepsIndent && /^-\s*/.test(trimmed)) itemIndent = indent;
    }
    if (itemIndent === null) continue;

    const itemStarts = [];
    for (let index = stepsIndex + 1; index < blockEnd; index++) {
      if (lineIndent(lines[index]) === itemIndent && /^\s*-\s*/.test(lines[index])) itemStarts.push(index);
    }
    for (let itemIndex = 0; itemIndex < itemStarts.length; itemIndex++) {
      const start = itemStarts[itemIndex];
      const end = itemStarts[itemIndex + 1] ?? blockEnd;
      const itemLines = lines.slice(start, end);
      const firstLine = itemLines[0].replace(/^\s*-\s*/, '');
      const firstMapping = firstLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      const mappingIndent = itemLines
        .slice(1)
        .map((line) => ({ line, indent: lineIndent(line), trimmed: line.trim() }))
        .find(({ indent, trimmed }) => indent > itemIndent && /^[A-Za-z0-9_-]+:\s*/.test(trimmed))?.indent;
      const fieldIndent = mappingIndent ?? itemIndent;
      const fields = [
        ...(firstMapping ? [{ indent: itemIndent, text: firstLine }] : []),
        ...itemLines.slice(1).map((line) => ({ indent: lineIndent(line), text: line.trim() })),
      ];
      const usesField = fields.find(({ indent, text }) => indent <= fieldIndent && /^uses:\s*/.test(text));
      if (!usesField || !yamlValue(usesField.text.replace(/^uses:\s*/, '')).startsWith('tauri-apps/tauri-action@')) continue;
      const nameField = fields.find(({ indent, text }) => indent <= fieldIndent && /^name:\s*/.test(text));
      const envField = fields.find(({ indent, text }) => indent === fieldIndent && /^env:\s*$/.test(text));
      const envKeys = [];
      if (envField) {
        const envIndex = itemLines.findIndex(
          (line) => lineIndent(line) === envField.indent && /^env:\s*$/.test(line.trim()),
        );
        for (let index = envIndex + 1; index < itemLines.length; index++) {
          const line = itemLines[index];
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          if (lineIndent(line) <= envField.indent) break;
          const key = trimmed.match(/^([A-Z0-9_]+):(?:\s|$)/);
          if (key) envKeys.push(key[1]);
        }
      }
      steps.push({
        name: nameField ? yamlValue(nameField.text.replace(/^name:\s*/, '')) : `<unnamed tauri step #${steps.length + 1}>`,
        envKeys,
      });
    }
  }
  return steps;
}

/**
 * Recursively collect literal VITE_* property reads under the client-
 * importable trees: src/ always, plus shared/ when present (it is imported by
 * src/ and would be bundled with it). Token-aware property reads cover direct,
 * parenthesized/cast, aliased, and bracket access without treating comments
 * or arbitrary string literals as reads.
 */
function readQuotedString(source, start) {
  const quote = source[start];
  let value = '';
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (character === '\\') {
      value += source[index + 1] ?? '';
      index++;
    } else if (character === quote) {
      return { value, end: index + 1 };
    } else if (character === '\n' || character === '\r') {
      return { value, end: index };
    } else {
      value += character;
    }
  }
  return { value, end: source.length };
}

function collectVitePropertyNames(source) {
  const vars = new Set();
  const add = (value) => {
    if (/^VITE_[A-Z0-9_]+$/.test(value)) vars.add(value);
  };
  const scan = (start, stopAtBrace = false) => {
    let braceDepth = 0;
    let previousSignificant = '';
    for (let index = start; index < source.length; index++) {
      const character = source[index];
      const next = source[index + 1];
      if (stopAtBrace && character === '}' && braceDepth === 0) return index + 1;
      if (character === '{') {
        braceDepth++;
        previousSignificant = character;
        continue;
      }
      if (character === '}') {
        braceDepth--;
        previousSignificant = character;
        continue;
      }
      if (character === '/' && next === '/') {
        const lineEnd = source.indexOf('\n', index + 2);
        index = lineEnd === -1 ? source.length : lineEnd;
        continue;
      }
      if (character === '/' && next === '*') {
        const commentEnd = source.indexOf('*/', index + 2);
        index = commentEnd === -1 ? source.length : commentEnd + 1;
        continue;
      }
      if (character === '`') {
        index++;
        while (index < source.length) {
          if (source[index] === '\\') {
            index++;
          } else if (source[index] === '`') {
            break;
          } else if (source[index] === '$' && source[index + 1] === '{') {
            index = scan(index + 2, true) - 1;
          }
          index++;
        }
        previousSignificant = '`';
        continue;
      }
      if (character === '\'' || character === '"') {
        const quoted = readQuotedString(source, index);
        if (previousSignificant === '[') add(quoted.value);
        index = quoted.end - 1;
        previousSignificant = 'string';
        continue;
      }
      if (character === '.') {
        const property = source.slice(index + 1).match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
        if (property) add(property[1]);
      } else if (character === '[') {
        let quotedIndex = index + 1;
        while (/\s/.test(source[quotedIndex] ?? '')) quotedIndex++;
        if (source[quotedIndex] === '\'' || source[quotedIndex] === '"') {
          const quoted = readQuotedString(source, quotedIndex);
          add(quoted.value);
        }
      }
      if (!/\s/.test(character)) previousSignificant = character;
    }
    return source.length;
  };
  scan(0);
  return vars;
}

export function collectSpaViteVars(rootDir) {
  const vars = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(entry)) {
        const source = readFileSync(full, 'utf8');
        for (const variable of collectVitePropertyNames(source)) vars.add(variable);
      }
    }
  };
  walk(path.join(rootDir, 'src'));
  const sharedDir = path.join(rootDir, 'shared');
  try {
    lstatSync(sharedDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [...vars].sort();
    throw err;
  }
  walk(sharedDir);
  return [...vars].sort();
}

export function checkDesktopBuildEnv(rootDir) {
  const errors = [];

  let workflowPaths = [];
  try {
    workflowPaths = discoverDesktopBuildWorkflows(rootDir);
  } catch (err) {
    errors.push(`.github/workflows: unable to discover workflow files — ${err.message}`);
  }
  if (workflowPaths.length === 0) {
    errors.push('.github/workflows: no workflow files with tauri-apps/tauri-action steps found — discovery broken or workflow inventory empty');
  }

  for (const workflowPath of workflowPaths) {
    const source = readFileSync(path.join(rootDir, workflowPath), 'utf8');
    const buildSteps = extractTauriBuildSteps(source);
    for (const step of buildSteps) {
      const missing = REQUIRED_DESKTOP_BUILD_ENV.filter((k) => !step.envKeys.includes(k));
      if (missing.length > 0) {
        errors.push(`${workflowPath} step "${step.name}": missing env ${missing.join(', ')}`);
      }
      const excluded = [...new Set(step.envKeys.filter((key) => Object.hasOwn(EXCLUDED_DESKTOP_BUILD_ENV, key)))];
      if (excluded.length > 0) {
        errors.push(`${workflowPath} step "${step.name}": declares excluded env ${excluded.join(', ')} — remove it from the desktop build`);
      }
    }
  }

  const classified = new Set([...REQUIRED_DESKTOP_BUILD_ENV, ...Object.keys(EXCLUDED_DESKTOP_BUILD_ENV)]);
  const spaVars = collectSpaViteVars(rootDir);
  if (spaVars.length === 0) {
    errors.push('src/ and shared/: no VITE_ property reads found — client env scan is empty');
  }
  const unclassified = spaVars.filter((v) => !classified.has(v));
  if (unclassified.length > 0) {
    errors.push(
      `unclassified VITE_ vars read by the SPA: ${unclassified.join(', ')} — add each to ` +
        'REQUIRED_DESKTOP_BUILD_ENV or EXCLUDED_DESKTOP_BUILD_ENV (with a reason) in scripts/check-desktop-build-env.mjs',
    );
  }

  return errors;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const rootFlagIndex = process.argv.indexOf('--root');
  const rootDir = rootFlagIndex !== -1 ? path.resolve(process.argv[rootFlagIndex + 1]) : process.cwd();

  const errors = checkDesktopBuildEnv(rootDir);
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::desktop build env: ${e}`);
    console.error('\nFix: declare the missing keys in the workflow env blocks (secret-sourced keys are safe to declare before the secret exists), or classify new vars in this script.');
    process.exit(1);
  }
  console.log(`desktop build env OK: ${REQUIRED_DESKTOP_BUILD_ENV.length} required keys present in every Tauri build step; all SPA VITE_ vars classified.`);
}
