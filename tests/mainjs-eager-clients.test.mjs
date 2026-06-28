import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// The five service modules below are statically imported by the eager boot
// graph (via @/app/data-loader). Their IntelligenceServiceClient MUST be
// constructed lazily (createLazyClient) so its constructor + getRpcBaseUrl()
// do NOT run at module eval on every dashboard boot (#4477 / #4410). A
// regression that reintroduces a module-scope `const x = new
// IntelligenceServiceClient(...)` re-eagerises construction and fails here.
//
// This is a SOURCE guard (greps src/), so it runs without a dist build —
// unlike the dist-gated chunk guards in dashboard-eager-chunks.test.mjs.
const EAGER_SERVICE_FILES = [
  'src/services/gdelt-intel.ts',
  'src/services/security-advisories.ts',
  'src/services/social-velocity.ts',
  'src/services/pizzint.ts',
  'src/services/satellites.ts',
];

// Matches an eager module/function-scope assignment `… = new IntelligenceServiceClient(`.
// The lazy factory form `createLazyClient(() => new IntelligenceServiceClient(` does NOT
// match: the char before `new` there is `>` (from `=>`), not `=` + whitespace.
const EAGER_CONSTRUCTION = /=\s*new IntelligenceServiceClient\(/;
const LAZY_FACTORY = /createLazyClient\(\(\)\s*=>\s*new IntelligenceServiceClient\(/;

describe('main.js eager diet — service clients are lazy-initialized', () => {
  for (const rel of EAGER_SERVICE_FILES) {
    const source = readFileSync(resolve(repoRoot, rel), 'utf8');

    it(`${rel} imports createLazyClient from rpc-client`, () => {
      assert.match(
        source,
        /import\s*\{[^}]*\bcreateLazyClient\b[^}]*\}\s*from\s*'@\/services\/rpc-client'/,
        `${rel} must import createLazyClient from @/services/rpc-client`,
      );
    });

    it(`${rel} constructs IntelligenceServiceClient via createLazyClient`, () => {
      assert.match(
        source,
        LAZY_FACTORY,
        `${rel} must wrap "new IntelligenceServiceClient(...)" in createLazyClient(() => ...)`,
      );
    });

    it(`${rel} has no module-scope eager "new IntelligenceServiceClient"`, () => {
      assert.doesNotMatch(
        source,
        EAGER_CONSTRUCTION,
        `${rel} must not assign "new IntelligenceServiceClient(...)" directly — that runs the constructor at boot`,
      );
    });
  }
});
