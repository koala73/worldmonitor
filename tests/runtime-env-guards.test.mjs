import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeSrc = readFileSync(resolve(__dirname, '../src/services/runtime.ts'), 'utf-8');
const variantSrc = readFileSync(resolve(__dirname, '../src/config/variant.ts'), 'utf-8');

describe('runtime env guards', () => {
  it('reads import.meta.env through a guarded ENV wrapper', () => {
    assert.match(
      runtimeSrc,
      /const ENV = \(\(\) => \{\s*try \{\s*return import\.meta\.env \?\? \{\};\s*\} catch \{\s*return \{\} as Record<string, string \| undefined>;/s,
    );
  });

  it('reuses the guarded ENV wrapper for runtime env lookups', () => {
    assert.ok(runtimeSrc.includes('const WS_API_URL = ENV.VITE_WS_API_URL || \'\''), 'WS API URL should read from ENV');
    assert.ok(runtimeSrc.includes('const FORCE_DESKTOP_RUNTIME = ENV.VITE_DESKTOP_RUNTIME === \'1\''), 'Desktop runtime flag should read from ENV');
    assert.ok(runtimeSrc.includes('const configuredBaseUrl = ENV.VITE_TAURI_API_BASE_URL;'), 'Tauri API base should read from ENV');
    assert.ok(runtimeSrc.includes('const configuredRemoteBase = ENV.VITE_TAURI_REMOTE_API_BASE_URL;'), 'Remote API base should read from ENV');
    assert.ok(runtimeSrc.includes('...extractHostnames(WS_API_URL, ENV.VITE_WS_RELAY_URL)'), 'Relay host extraction should read from ENV');
  });
});

describe('variant env guards', () => {
  it('computes the build variant through a guarded import.meta.env access', () => {
    assert.match(
      variantSrc,
      /const buildVariant = \(\(\) => \{\s*try \{\s*return import\.meta\.env\?\.VITE_VARIANT \|\| 'full';\s*\} catch \{\s*return 'full';\s*\}\s*\}\)\(\);/s,
    );
  });

  it('reuses buildVariant for SSR, Tauri, and localhost fallback paths', () => {
    const buildVariantUses = variantSrc.match(/return buildVariant;/g) ?? [];
    assert.equal(buildVariantUses.length, 3, `Expected three buildVariant fallbacks, got ${buildVariantUses.length}`);
    assert.ok(variantSrc.includes("if (typeof window === 'undefined') return buildVariant;"), 'SSR should fall back to buildVariant');
  });
});
