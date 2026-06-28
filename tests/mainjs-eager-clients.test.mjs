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

// Matches a direct eager assignment without crossing string-literal quotes.
const EAGER_CONSTRUCTION = /^[^'"`\n]*=\s*new IntelligenceServiceClient\(/m;
const LAZY_FACTORY = /createLazyClient\(\(\)\s*=>\s*new IntelligenceServiceClient\(/;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('main.js eager diet — service clients are lazy-initialized', () => {
  it('does not flag line-commented examples of the eager pattern', () => {
    const commentedExample = '// was: const client = new IntelligenceServiceClient(getRpcBaseUrl(), {})';
    assert.doesNotMatch(stripComments(commentedExample), EAGER_CONSTRUCTION);
  });

  it('does not flag string-literal examples of the eager pattern', () => {
    const stringExample = 'const example = "was: = new IntelligenceServiceClient(getRpcBaseUrl(), {})";';
    assert.doesNotMatch(stripComments(stringExample), EAGER_CONSTRUCTION);
  });

  it('still flags direct eager client declarations', () => {
    const eagerDeclaration = 'const client: IntelligenceServiceClient = new IntelligenceServiceClient(getRpcBaseUrl(), {})';
    assert.match(stripComments(eagerDeclaration), EAGER_CONSTRUCTION);
  });

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
        stripComments(source),
        EAGER_CONSTRUCTION,
        `${rel} must not assign "new IntelligenceServiceClient(...)" directly — that runs the constructor at boot`,
      );
    });
  }
});
