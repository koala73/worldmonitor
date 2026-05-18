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
 * These tests assert all three invariants so a future contributor who
 * accidentally widens any of them gets a CI failure with a pointer
 * back to issue #3704.
 *
 * To add another platform-only secret to the guard, extend
 * `PLATFORM_ONLY_SECRETS` below.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Server-side secrets that MUST NOT cross into the browser bundle. Each
// of these grants access to worldmonitor.app infrastructure (enterprise
// API tier, signing keys, etc.) — distinct from per-user provider
// credentials (GROQ_API_KEY, OPENROUTER_API_KEY) which users
// legitimately enter via the desktop settings UI.
const PLATFORM_ONLY_SECRETS = [
  'WORLDMONITOR_API_KEY',
] as const;

async function readRepoFile(relPath: string): Promise<string> {
  return readFile(new URL(`../${relPath}`, import.meta.url), 'utf8');
}

describe('browser bundle secret guard (#3704)', () => {
  it('runtime-config.ts does not list a platform-only secret as a required feature secret', async () => {
    const source = await readRepoFile('src/services/runtime-config.ts');
    // `requiredSecrets: [...]` literals are what seedSecretsFromEnvironment iterates.
    // Any platform-only key appearing inside one of those arrays would be
    // attempted at runtime, so flag it.
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
    // of `envPrefix`. Flag any reference to a platform-only secret name
    // inside the rough vicinity of a define block.
    const defineMatch = source.match(/define:\s*\{[\s\S]{0,2000}?\n\s*\},/);
    assert.ok(defineMatch, 'expected to find a define: block in vite.config.ts');
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
    // sets `envPrefix: ''` or includes a non-VITE_ prefix, unprefixed
    // env vars (including platform secrets) become reachable via
    // `import.meta.env` in the browser bundle.
    const envPrefixMatch = source.match(/envPrefix\s*:\s*([^,\n}]+)/);
    if (envPrefixMatch) {
      const value = envPrefixMatch[1].trim();
      assert.ok(
        value.includes('VITE_') || value.includes('PUBLIC_'),
        `vite.config.ts sets envPrefix=${value}; this must include the VITE_/PUBLIC_ ` +
          `convention or unprefixed platform secrets become reachable from the ` +
          `browser bundle. See issue #3704.`,
      );
    }
    // No envPrefix override = Vite default = safe. No assertion needed.
  });

  it('readEnvSecret returns empty when import.meta.env lacks the platform secret', async () => {
    // Dynamic import so the module loads in this Node test runner; the
    // bundler-time `import.meta.env` shape matches what Vite produces.
    const mod = await import('../src/services/runtime-config.ts');
    // The module's exported public surface intentionally does not include
    // readEnvSecret — assert via getRuntimeConfigSnapshot that no
    // platform-only secret was seeded at module load time (default
    // import.meta.env contains no platform secrets in node test env).
    const snapshot = mod.getRuntimeConfigSnapshot();
    for (const secret of PLATFORM_ONLY_SECRETS) {
      assert.equal(
        (snapshot.secrets as Record<string, unknown>)[secret],
        undefined,
        `${secret} was seeded into runtimeConfig.secrets at module load time. ` +
          `Platform secrets must never appear in the browser runtime snapshot. ` +
          `See issue #3704.`,
      );
    }
  });
});
