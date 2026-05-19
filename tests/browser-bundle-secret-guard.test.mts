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
import { readFile } from 'node:fs/promises';

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

// Safe envPrefix entries — anything else exposes unprefixed env vars to
// the browser bundle. Keep this list narrow.
const SAFE_ENV_PREFIXES = ['VITE_', 'PUBLIC_'];

async function readRepoFile(relPath: string): Promise<string> {
  return readFile(new URL(`../${relPath}`, import.meta.url), 'utf8');
}

describe('browser bundle secret guard (#3704)', () => {
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
    for (const secret of PLATFORM_ONLY_SECRETS) {
      assert.ok(
        !defineMatch[0].includes(secret),
        `${secret} appears inside the vite.config.ts define: block. ` +
          `That inlines the literal value into the browser bundle. See issue #3704.`,
      );
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
