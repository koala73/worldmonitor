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
 * 2. Every `import.meta.env.VITE_*` variable the SPA reads is classified
 *    here as REQUIRED or EXCLUDED. A new unclassified var fails this check,
 *    forcing the author to decide — and record — whether desktop builds
 *    need it, instead of silently omitting it the way the #5905 set was.
 *
 * Run: node scripts/check-desktop-build-env.mjs [--root <repo-root>]
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  'VITE_VAPID_PUBLIC_KEY', //   web-push guard testability (push stays Tauri-excluded)
  'VITE_ENABLE_CYBER_LAYER', // Cyber Threats layer; absent => hidden (#5829 half)
  'VITE_WS_RELAY_URL', //       desktop military-flights direct OpenSky path
  'VITE_PMTILES_URL_PUBLIC', // self-hosted basemap on desktop (else OpenFreeMap fallback)
];

// SPA-read VITE_ vars that desktop builds deliberately do NOT set.
// Every entry needs a reason: this map is the decision record.
export const EXCLUDED_DESKTOP_BUILD_ENV = {
  VITE_ENABLE_IRAN_ATTACKS: 'feature sunset, default-off everywhere (#4982)',
  VITE_ENABLE_AIS: "opt-out flag (only 'false' disables); unset default is enabled — correct on desktop, where AIS is gated by the aisRelay keyring feature instead",
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

// Workflow files containing Tauri build steps, relative to repo root.
export const DESKTOP_BUILD_WORKFLOWS = [
  '.github/workflows/build-desktop.yml',
  '.github/workflows/test-linux-app.yml',
];

/**
 * Extract every step block using tauri-apps/tauri-action from a workflow
 * source, returning [{ name, envKeys }]. Line-based: a step starts at
 * `      - name: ...` (6-space indent) and ends at the next step or EOF.
 */
export function extractTauriBuildSteps(workflowSource) {
  const lines = workflowSource.replace(/\r\n/g, '\n').split('\n');
  const steps = [];
  let current = null;

  for (const line of lines) {
    const stepStart = line.match(/^ {6}- name: (.*)$/);
    if (stepStart) {
      if (current) steps.push(current);
      current = { name: stepStart[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) steps.push(current);

  return steps
    .filter((s) => s.lines.some((l) => /^\s+uses: tauri-apps\/tauri-action@/.test(l)))
    .map((s) => {
      const envKeys = [];
      let inEnv = false;
      for (const l of s.lines) {
        if (/^ {8}env:\s*$/.test(l)) {
          inEnv = true;
          continue;
        }
        if (inEnv) {
          const kv = l.match(/^ {10}([A-Z0-9_]+):/);
          if (kv) {
            envKeys.push(kv[1]);
            continue;
          }
          if (!/^\s*#/.test(l) && l.trim() !== '') inEnv = false;
        }
      }
      return { name: s.name, envKeys };
    });
}

/**
 * Recursively collect VITE_* vars read via import.meta.env under the
 * client-importable trees: src/ always, plus shared/ when present (it is
 * imported by src/ and would be bundled with it).
 */
export function collectSpaViteVars(rootDir) {
  const vars = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) {
        const source = readFileSync(full, 'utf8');
        for (const m of source.matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) {
          vars.add(m[1]);
        }
      }
    }
  };
  walk(path.join(rootDir, 'src'));
  try {
    walk(path.join(rootDir, 'shared'));
  } catch {
    // shared/ absent (fixture roots, future restructure) — src/ scan stands.
  }
  return [...vars].sort();
}

export function checkDesktopBuildEnv(rootDir) {
  const errors = [];

  for (const workflowPath of DESKTOP_BUILD_WORKFLOWS) {
    const source = readFileSync(path.join(rootDir, workflowPath), 'utf8');
    const buildSteps = extractTauriBuildSteps(source);
    if (buildSteps.length === 0) {
      errors.push(`${workflowPath}: no tauri-apps/tauri-action steps found — extraction broken or workflow restructured`);
      continue;
    }
    for (const step of buildSteps) {
      const missing = REQUIRED_DESKTOP_BUILD_ENV.filter((k) => !step.envKeys.includes(k));
      if (missing.length > 0) {
        errors.push(`${workflowPath} step "${step.name}": missing env ${missing.join(', ')}`);
      }
    }
  }

  const classified = new Set([...REQUIRED_DESKTOP_BUILD_ENV, ...Object.keys(EXCLUDED_DESKTOP_BUILD_ENV)]);
  const unclassified = collectSpaViteVars(rootDir).filter((v) => !classified.has(v));
  if (unclassified.length > 0) {
    errors.push(
      `unclassified VITE_ vars read by the SPA: ${unclassified.join(', ')} — add each to ` +
        'REQUIRED_DESKTOP_BUILD_ENV or EXCLUDED_DESKTOP_BUILD_ENV (with a reason) in scripts/check-desktop-build-env.mjs',
    );
  }

  return errors;
}

// Realpath BOTH sides: with only argv[1] raw, a symlinked invocation path
// (macOS /tmp -> /private/tmp) makes the comparison silently false and the
// gate a no-op that exits 0 — the fail-open documented in
// docs/solutions/ for main-module guards on ESM CLI gates.
const isMain =
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href ===
    pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;

if (isMain) {
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
