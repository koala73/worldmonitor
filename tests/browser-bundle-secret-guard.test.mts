/**
 * Defensive guard for issue #3704.
 *
 * The reporter flagged that the browser runtime *appeared* to seed
 * `WORLDMONITOR_API_KEY` (a server-side platform credential) into
 * client-readable state. Investigation showed the architecture is
 * actually safe today because:
 *
 *   1. Vite's default `envPrefix: 'VITE_'` blocks any unprefixed env
 *      var from being inlined into `import.meta.env` in the browser
 *      bundle. `WORLDMONITOR_API_KEY` has no prefix → invisible to
 *      `readEnvSecret()` at runtime in web builds.
 *
 *   2. No entry in `RUNTIME_FEATURES.requiredSecrets` references
 *      `WORLDMONITOR_API_KEY`, so `seedSecretsFromEnvironment()` never
 *      iterates over it — the key isn't even attempted.
 *
 *   3. `vite.config.ts` does not pass `WORLDMONITOR_API_KEY` through
 *      its `define:` block (which would inline the literal value into
 *      the bundle regardless of `envPrefix`).
 *
 * These tests assert all three invariants for every entry in
 * `PLATFORM_ONLY_SECRETS` so a future contributor who accidentally
 * widens any of them gets a CI failure with a pointer back to issue
 * #3704.
 *
 * To add another platform-only secret to the guard, extend the
 * `PLATFORM_ONLY_SECRETS` constant below.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

// Server-side secrets that MUST NOT cross into the browser bundle. Each
// of these grants access to worldmonitor.app infrastructure. They are
// distinct from per-user provider credentials (GROQ_API_KEY,
// OPENROUTER_API_KEY, etc.) which users legitimately enter via the
// desktop settings UI.
const PLATFORM_ONLY_SECRETS = [
  // Enterprise tier key — possession grants enterprise API access (see
  // api/_api-key.js validation against WORLDMONITOR_VALID_KEYS).
  'WORLDMONITOR_API_KEY',
  // Allowlist of accepted enterprise keys — leaking it reveals all
  // accepted keys at once.
  'WORLDMONITOR_VALID_KEYS',
  // Signs anonymous browser session tokens (see api/_session.js).
  // Leakage lets attackers mint valid wms_ tokens.
  'WM_SESSION_SECRET',
  // Signs Pro MCP grants (see api/_mcp-grant-hmac.ts). Leakage lets
  // attackers mint valid Pro MCP grants for arbitrary users.
  'MCP_PRO_GRANT_HMAC_SECRET',
] as const;

// Server/provider credentials that must never be made reachable from browser
// bundles. The VITE_* aliases are deliberately listed because a client prefix
// on a server credential is still a server credential exposure.
const SERVER_OR_PROVIDER_SECRET_ENV_NAMES = [
  ...PLATFORM_ONLY_SECRETS,
  'AISSTREAM_API_KEY',
  'VITE_AISSTREAM_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'VITE_CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_R2_TOKEN',
  'VITE_CLOUDFLARE_R2_TOKEN',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'VITE_CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'VITE_CLOUDFLARE_R2_ACCESS_KEY_ID',
  'RELAY_SHARED_SECRET',
  'VITE_RELAY_SHARED_SECRET',
  'UPSTASH_REDIS_REST_TOKEN',
  'VITE_UPSTASH_REDIS_REST_TOKEN',
  'DODO_API_KEY',
  'VITE_DODO_API_KEY',
] as const;

// Client-readable env names currently used by browser source. This list is
// intentionally explicit so a future VITE_* provider token must be reviewed
// instead of quietly joining the bundle.
const CLIENT_ENV_ALLOWLIST = new Set([
  'VITE_CLERK_PUBLISHABLE_KEY',
  'VITE_CLOUD_PREFS_ENABLED',
  'VITE_CONVEX_URL',
  'VITE_DESKTOP_RUNTIME',
  'VITE_DIGEST_CRON_ENABLED',
  'VITE_DODO_ENVIRONMENT',
  'VITE_E2E',
  'VITE_ENABLE_AIS',
  'VITE_ENABLE_CYBER_LAYER',
  'VITE_FOLLOW_COUNTRIES_ENABLED',
  'VITE_HORMUZ_CRISIS_START_DATE',
  'VITE_MAP_INTERACTION_MODE',
  'VITE_OPENSKY_RELAY_URL',
  'VITE_PMTILES_URL',
  'VITE_PMTILES_URL_PUBLIC',
  'VITE_QUIET_HOURS_BATCH_ENABLED',
  'VITE_RELAY_GATES_READY',
  'VITE_RSS_DIRECT_TO_RELAY',
  'VITE_SENTRY_DSN',
  'VITE_TAURI_API_BASE_URL',
  'VITE_TAURI_REMOTE_API_BASE_URL',
  'VITE_TELEGRAM_BOT_USERNAME',
  'VITE_VAPID_PUBLIC_KEY',
  'VITE_VARIANT',
  'VITE_WS_API_URL',
  'VITE_WS_RELAY_URL',
]);

// Safe envPrefix entries — anything else exposes unprefixed env vars to
// the browser bundle. Keep this list narrow.
const SAFE_ENV_PREFIXES = ['VITE_', 'PUBLIC_'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const CLIENT_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']);
const BUILT_ASSET_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.map']);

async function readRepoFile(relPath: string): Promise<string> {
  return readFile(new URL(`../${relPath}`, import.meta.url), 'utf8');
}

async function listFiles(root: string, extensions: Set<string>): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
      continue;
    }
    const fullPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath, extensions));
      continue;
    }
    const dot = entry.name.lastIndexOf('.');
    const ext = dot >= 0 ? entry.name.slice(dot) : '';
    if (extensions.has(ext)) files.push(fullPath);
  }
  return files;
}

function extractViteEnvNames(source: string): string[] {
  const keys = new Set<string>();
  const sourceFile = ts.createSourceFile('client-source.ts', source, ts.ScriptTarget.Latest, true);

  function isImportMetaEnvExpression(expression: ts.Expression): boolean {
    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'env') {
      return false;
    }
    const receiver = expression.expression;
    return ts.isMetaProperty(receiver)
      && receiver.keywordToken === ts.SyntaxKind.ImportKeyword
      && receiver.name.text === 'meta';
  }

  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node)) {
      const envName = node.name.text;
      if (/^VITE_[A-Z0-9_]+$/.test(envName) && isImportMetaEnvExpression(node.expression)) {
        keys.add(envName);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...keys].sort();
}

describe('browser bundle secret guard (#3704)', () => {
  it('tracks Cloudflare and AISStream provider secret classes, including unsafe VITE aliases', () => {
    for (const envName of [
      'CLOUDFLARE_API_TOKEN',
      'VITE_CLOUDFLARE_API_TOKEN',
      'AISSTREAM_API_KEY',
      'VITE_AISSTREAM_API_KEY',
    ]) {
      assert.ok(
        SERVER_OR_PROVIDER_SECRET_ENV_NAMES.includes(envName as (typeof SERVER_OR_PROVIDER_SECRET_ENV_NAMES)[number]),
        `${envName} must stay in the browser-bundle prohibited secret set`,
      );
    }
  });

  it('runtime env readers do not make the full Vite env object reachable', async () => {
    for (const relPath of ['src/services/runtime.ts', 'src/services/runtime-config.ts']) {
      const source = await readRepoFile(relPath);
      assert.doesNotMatch(
        source,
        /return\s+import\.meta\.env\b/,
        `${relPath} must not return import.meta.env wholesale`,
      );
      assert.doesNotMatch(
        source,
        /\b(?:const|let|var)\s+\w+\s*=\s*import\.meta\.env\b/,
        `${relPath} must not snapshot import.meta.env into a local object`,
      );
      assert.doesNotMatch(
        source,
        /\.env\??\.\[[^\]]+\]/,
        `${relPath} must not dynamically index import.meta.env`,
      );
    }
  });

  it('client source uses only reviewed VITE_* browser env names', async () => {
    const sourceFiles = await listFiles(resolve(repoRoot, 'src'), CLIENT_SOURCE_EXTENSIONS);
    const seen = new Map<string, string[]>();

    for (const file of sourceFiles) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(
        source,
        /import\.meta\.env\?\./,
        `${relative(repoRoot, file)} must not optional-chain import.meta.env; ` +
          `Vite may preserve the full env object instead of inlining one key.`,
      );
      for (const key of extractViteEnvNames(source)) {
        const relPath = relative(repoRoot, file);
        seen.set(key, [...(seen.get(key) ?? []), relPath]);
      }
    }

    for (const [key, paths] of seen) {
      assert.ok(
        CLIENT_ENV_ALLOWLIST.has(key),
        `${key} is read by browser source but is not in the reviewed client env allowlist. ` +
          `First seen in ${paths[0]}. Server/provider secrets must not use VITE_ aliases.`,
      );
    }
  });

  it('runtime-config.ts does not list a platform-only secret as a required feature secret', async () => {
    const source = await readRepoFile('src/services/runtime-config.ts');
    // `requiredSecrets: [...]` literals are what seedSecretsFromEnvironment iterates.
    // Any platform-only key appearing inside one of those arrays would be
    // attempted at runtime, so flag it.
    //
    // The regex assumes requiredSecrets stays a flat string array. If the
    // shape ever changes (e.g. requiredSecrets: [{ key: 'X', tier: 'A' }]),
    // the lazy `[^\]]*` will stop at the first inner `]` and miss content.
    // Update this regex if/when that shape changes.
    const requiredSecretsBlocks = source.match(/requiredSecrets:\s*\[[^\]]*\]/g) ?? [];
    for (const block of requiredSecretsBlocks) {
      for (const secret of PLATFORM_ONLY_SECRETS) {
        assert.ok(
          !block.includes(`'${secret}'`) && !block.includes(`"${secret}"`),
          `${secret} appears in a RUNTIME_FEATURES.requiredSecrets array. ` +
            `Server-side platform secrets must not be seeded into the browser ` +
            `runtime config. See issue #3704.`,
        );
      }
    }
  });

  it('vite.config.ts does not inline platform-only secrets via define', async () => {
    const source = await readRepoFile('vite.config.ts');
    // `define:` injects literal values into the client bundle regardless
    // of `envPrefix`. We only need to inspect the block when it exists —
    // a future refactor that removes the block entirely is strictly
    // safer (nothing to accidentally inline) and must not fail this
    // guard. Only validate contents when the block is present.
    const defineMatch = source.match(/define:\s*\{[\s\S]{0,2000}?\n\s*\},/);
    if (!defineMatch) return;
    for (const secret of SERVER_OR_PROVIDER_SECRET_ENV_NAMES) {
      assert.ok(
        !defineMatch[0].includes(secret),
        `${secret} appears inside the vite.config.ts define: block. ` +
          `That inlines the literal value into the browser bundle. See issue #3704.`,
      );
    }
  });

  it('built browser assets do not contain configured server/provider secret values when dist exists', async () => {
    const distDir = process.env.WM_BROWSER_BUNDLE_GUARD_DIST_DIR || resolve(repoRoot, 'dist');
    try {
      if (!(await stat(distDir)).isDirectory()) return;
    } catch {
      return;
    }

    const configuredSecrets = SERVER_OR_PROVIDER_SECRET_ENV_NAMES
      .map((envName) => [envName, process.env[envName]] as const)
      .filter((entry): entry is readonly [string, string] => (
        typeof entry[1] === 'string' && entry[1].length >= 12
      ));

    if (configuredSecrets.length === 0) return;

    const assetFiles = await listFiles(distDir, BUILT_ASSET_EXTENSIONS);
    for (const file of assetFiles) {
      const source = await readFile(file, 'utf8');
      for (const [envName, value] of configuredSecrets) {
        assert.ok(
          !source.includes(value),
          `${envName} value was found in built browser asset ${relative(repoRoot, file)}. ` +
            `Rotate the credential and remove any client-prefixed copy from deployment env.`,
        );
      }
    }
  });

  it('vite.config.ts does not set a custom envPrefix that would expose unprefixed secrets', async () => {
    const source = await readRepoFile('vite.config.ts');
    // Vite's default is `envPrefix: 'VITE_'`. If a future contributor
    // sets `envPrefix: ''`, includes a non-VITE_ prefix in an array form
    // (`envPrefix: ['VITE_', '']`), or replaces the default with a
    // narrower string that doesn't include VITE_/PUBLIC_, unprefixed env
    // vars become reachable via `import.meta.env` in the browser bundle.
    // Match either a string literal (`envPrefix: 'X'`) or a bracketed
    // array (`envPrefix: ['A', 'B']`). The 200-char ceiling on array
    // contents is generous — real values are <50 chars.
    const envPrefixMatch = source.match(
      /envPrefix\s*:\s*(\[[^\]]{0,200}\]|'[^']*'|"[^"]*")/,
    );
    if (!envPrefixMatch) {
      // No envPrefix override = Vite default = safe.
      return;
    }

    const raw = envPrefixMatch[1].trim();
    // Parse JS-style string or array literal. We rewrite single quotes
    // to double quotes so JSON.parse can handle the common case.
    let value: unknown;
    try {
      value = JSON.parse(raw.replace(/'/g, '"'));
    } catch {
      assert.fail(
        `vite.config.ts envPrefix has an unparseable value ${raw}. ` +
          `Defensive guard for #3704 cannot verify entries.`,
      );
    }

    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      assert.ok(
        typeof entry === 'string' && SAFE_ENV_PREFIXES.some(safe => entry.startsWith(safe)),
        `vite.config.ts envPrefix entry ${JSON.stringify(entry)} is not in the safe ` +
          `prefix allowlist (${SAFE_ENV_PREFIXES.join(', ')}). Empty-string or ` +
          `non-VITE_/PUBLIC_ entries expose unprefixed platform secrets to the ` +
          `browser bundle. See issue #3704.`,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // NOTE: a prior draft of this file included a 4th test that imported
  // `runtime-config.ts` and asserted `getRuntimeConfigSnapshot().secrets`
  // contained no platform-only secret at module load. Greptile flagged
  // it (PR #3786 review) as vacuous: in node:test, `import.meta.env` is
  // undefined, so `readEnvSecret()` returns `''` for every key
  // regardless of what's in `process.env` or what's listed in
  // `requiredSecrets`. The snapshot is always empty and the assertion
  // always passes — even if `WORLDMONITOR_API_KEY` were added to a
  // `requiredSecrets` array (the exact regression test #1 above catches).
  //
  // The HONEST runtime check is a bundle-content grep after `npm run build`:
  //
  //   npm run build
  //   grep -r "WORLDMONITOR_API_KEY" dist/  # must return zero hits
  //
  // That's done at deploy time, not unit-test time. Tests #1–#3 above
  // are the load-bearing CI guards.
  // ─────────────────────────────────────────────────────────────────
});
