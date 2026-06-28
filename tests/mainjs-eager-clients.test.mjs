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

const DATA_LOADER_DEFERRED_SERVICE_IMPORTS = [
  '@/services/rss',
  '@/services/signal-aggregator',
  '@/services/trending-keywords',
  '@/services/daily-market-brief',
];

const DATA_LOADER_DEFERRED_BARREL_EXPORTS = [
  'fetchCategoryFeeds',
  'getFeedFailures',
];

const COUNTRY_INTEL_DEFERRED_SERVICE_IMPORTS = [
  '@/services/signal-aggregator',
];

// Matches a direct eager assignment without crossing string-literal quotes.
const EAGER_CONSTRUCTION = /^[^'"`\n]*=\s*new IntelligenceServiceClient\(/m;
const LAZY_FACTORY = /createLazyClient\(\(\)\s*=>\s*new IntelligenceServiceClient\(/;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function valueImportSpecifiers(src) {
  const specifiers = [];
  const re = /\bimport\s+(?!type\b)[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function servicesBarrelValueImportBlock(src) {
  return src.match(/\bimport\s+\{([\s\S]*?)\}\s+from\s+['"]@\/services['"]/)?.[1] ?? '';
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

describe('main.js eager diet — data-loader service tail is lazy-loaded', () => {
  const source = readFileSync(resolve(repoRoot, 'src/app/data-loader.ts'), 'utf8');
  const withoutComments = stripComments(source);

  it('keeps post-paint service modules behind dynamic imports', () => {
    const valueSpecifiers = valueImportSpecifiers(withoutComments);
    const directOffenders = DATA_LOADER_DEFERRED_SERVICE_IMPORTS.filter((specifier) => valueSpecifiers.includes(specifier));
    assert.deepEqual(
      directOffenders,
      [],
      'data-loader must not statically import RSS/trending/signal/daily-brief services; load them through cached import() helpers after first paint',
    );

    for (const specifier of DATA_LOADER_DEFERRED_SERVICE_IMPORTS) {
      assert.ok(
        withoutComments.includes(`import('${specifier}')`),
        `data-loader should lazy-load ${specifier} with import()`,
      );
    }
  });

  it('does not pull RSS fallback exports through the eager services barrel', () => {
    const servicesImportBlock = servicesBarrelValueImportBlock(withoutComments);
    const offenders = DATA_LOADER_DEFERRED_BARREL_EXPORTS.filter((name) => new RegExp(`\\b${name}\\b`).test(servicesImportBlock));
    assert.deepEqual(
      offenders,
      [],
      'RSS fallback exports pull rss.ts and its enrichment imports into the eager data-loader graph; use getRssModule() instead',
    );
  });
});

describe('main.js eager diet — country-intel service tail is lazy-loaded', () => {
  const source = readFileSync(resolve(repoRoot, 'src/app/country-intel.ts'), 'utf8');
  const withoutComments = stripComments(source);

  it('keeps signal aggregation behind a dynamic import', () => {
    const valueSpecifiers = valueImportSpecifiers(withoutComments);
    const directOffenders = COUNTRY_INTEL_DEFERRED_SERVICE_IMPORTS.filter((specifier) => valueSpecifiers.includes(specifier));
    assert.deepEqual(
      directOffenders,
      [],
      'country-intel is part of the eager App graph; signal aggregation must load through import() on country-brief/story actions',
    );

    for (const specifier of COUNTRY_INTEL_DEFERRED_SERVICE_IMPORTS) {
      assert.ok(
        withoutComments.includes(`import('${specifier}')`),
        `country-intel should lazy-load ${specifier} with import()`,
      );
    }
  });
});
