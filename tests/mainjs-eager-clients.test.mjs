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
  '@/services/trending-keywords',
  '@/services/daily-market-brief',
];

const SIGNAL_AGGREGATOR_DEFERRED_SERVICE_IMPORT = '@/services/signal-aggregator';
const MILITARY_VESSELS_DEFERRED_SERVICE_IMPORT = '@/services/military-vessels';
const CROSS_MODULE_DEFERRED_SERVICE_IMPORT = '@/services/cross-module-integration';
const INTELLIGENCE_GAP_BADGE_DEFERRED_IMPORT = '@/components/IntelligenceGapBadge';
const EXPORT_PANEL_DEFERRED_IMPORT = '@/utils/export';
const SIGNAL_MODAL_DEFERRED_IMPORT = '@/components/SignalModal';

const SERVICE_BARREL_DEFERRED_EXPORTS = [
  './rss',
  './trending-keywords',
  './daily-market-brief',
  './military-vessels',
  './cross-module-integration',
];

const DATA_LOADER_DEFERRED_BARREL_EXPORTS = [
  'fetchCategoryFeeds',
  'getFeedFailures',
  'drainTrendingSignals',
  'ingestHeadlines',
  'buildDailyMarketBrief',
  'cacheDailyMarketBrief',
  'getCachedDailyMarketBrief',
  'shouldRefreshDailyBrief',
  'fetchMilitaryVessels',
  'initMilitaryVesselStream',
  'isMilitaryVesselTrackingConfigured',
];


const DATA_LOADER_LAZY_PROMISE_SLOTS = [
  'dailyMarketBriefModulePromise',
  'rssModulePromise',
  'ingestHeadlinesPromise',
  'drainTrendingSignalsPromise',
];

// Matches a direct eager assignment without crossing string-literal quotes.
const EAGER_CONSTRUCTION = /^[^'"`\n]*=\s*new IntelligenceServiceClient\(/m;
const LAZY_FACTORY = /createLazyClient\(\(\)\s*=>\s*new IntelligenceServiceClient\(/;
// Counts every construction site and every lazy-wrapped one. EAGER_CONSTRUCTION
// only catches the `<lhs> = new ...` assignment form; these catch the
// non-assignment eager forms it misses (`export default new ...`, a standalone
// `new ...().warmup()` call, an IIFE) by requiring construction count to equal
// lazy-wrapped count — i.e. every construction must go through createLazyClient.
const ANY_CONSTRUCTION = /new\s+IntelligenceServiceClient\s*\(/g;
const LAZY_CONSTRUCTION = /createLazyClient\(\s*\(\)\s*=>\s*new\s+IntelligenceServiceClient\s*\(/g;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function escapeRegExp(value) {
  const special = '\\^$.*+?()[]{}|';
  return [...value].map((ch) => special.includes(ch) ? '\\' + ch : ch).join('');
}

function skipQuoted(src, index, quote) {
  let i = index + 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return src.length;
}

function dynamicImportSpecifiers(src) {
  const specifiers = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(src, i, ch);
      continue;
    }
    if (src.startsWith('import', i) && !/[A-Za-z0-9_$]/.test(src[i - 1] ?? '') && !/[A-Za-z0-9_$]/.test(src[i + 6] ?? '')) {
      if (/\btypeof\s*$/.test(src.slice(Math.max(0, i - 16), i))) {
        i++;
        continue;
      }
      let j = i + 6;
      while (/\s/.test(src[j] ?? '')) j++;
      if (src[j] !== '(') {
        i++;
        continue;
      }
      j++;
      while (/\s/.test(src[j] ?? '')) j++;
      const quote = src[j];
      if (quote !== "'" && quote !== '"') {
        i++;
        continue;
      }
      j++;
      let specifier = '';
      while (j < src.length) {
        if (src[j] === '\\') {
          specifier += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          specifiers.push(specifier);
          i = j + 1;
          break;
        }
        specifier += src[j];
        j++;
      }
      if (j >= src.length) i = src.length;
      continue;
    }
    i++;
  }
  return specifiers;
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

function valueImportBlock(src, specifier) {
  const re = new RegExp(`\\bimport\\s+\\{([\\s\\S]*?)\\}\\s+from\\s+['"]${escapeRegExp(specifier)}['"]`, 'g');
  return [...src.matchAll(re)].map((match) => match[1]).join('\n');
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

  it('construction-count check catches non-assignment eager forms EAGER_CONSTRUCTION misses', () => {
    const countWrapped = (src) =>
      (stripComments(src).match(LAZY_CONSTRUCTION) ?? []).length ===
      (stripComments(src).match(ANY_CONSTRUCTION) ?? []).length;

    // Bypasses that EAGER_CONSTRUCTION (assignment-only) does NOT catch:
    assert.equal(countWrapped('export default new IntelligenceServiceClient(getRpcBaseUrl(), {})'), false);
    assert.equal(countWrapped('new IntelligenceServiceClient(getRpcBaseUrl(), {}).warmup();'), false);
    assert.equal(countWrapped('const c = (() => new IntelligenceServiceClient(x))();'), false);
    // An eager construction added alongside a legit lazy factory must still fail:
    assert.equal(
      countWrapped(
        'const client = createLazyClient(() => new IntelligenceServiceClient(getRpcBaseUrl(), {}));\n' +
          'new IntelligenceServiceClient(getRpcBaseUrl(), {}).getCountryFacts();',
      ),
      false,
    );
    // A correctly lazy-wrapped sole construction passes:
    assert.equal(
      countWrapped('const client = createLazyClient(() => new IntelligenceServiceClient(getRpcBaseUrl(), {}));'),
      true,
    );
  });

  it('detects dynamic imports without accepting comments or string literals', () => {
    assert.deepEqual(dynamicImportSpecifiers('const fixture = "import(\'@/services/rss\')";'), []);
    assert.deepEqual(dynamicImportSpecifiers('// import(\'@/services/rss\')\n'), []);
    assert.deepEqual(dynamicImportSpecifiers("type Rss = typeof import('@/services/rss');"), []);
    assert.deepEqual(dynamicImportSpecifiers("void import('@/services/rss')"), ['@/services/rss']);
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

    it(`${rel} wraps every IntelligenceServiceClient construction in createLazyClient`, () => {
      const clean = stripComments(source);
      const totalConstructions = (clean.match(ANY_CONSTRUCTION) ?? []).length;
      const lazyConstructions = (clean.match(LAZY_CONSTRUCTION) ?? []).length;
      assert.equal(
        lazyConstructions,
        totalConstructions,
        `every "new IntelligenceServiceClient(...)" in ${rel} must be wrapped in createLazyClient(() => ...) ` +
          `so the constructor never runs at boot — found ${totalConstructions} construction(s), ` +
          `${lazyConstructions} lazy-wrapped (non-assignment forms like "export default new ...", ` +
          `a standalone "new ...().warmup()", or an IIFE re-eagerise construction)`,
      );
    });
  }
});

describe('main.js eager diet — data-loader service tail is lazy-loaded', () => {
  const source = readFileSync(resolve(repoRoot, 'src/app/data-loader.ts'), 'utf8');
  const withoutComments = stripComments(source);

  it('keeps post-paint service modules behind dynamic imports', () => {
    const valueSpecifiers = valueImportSpecifiers(withoutComments);
    const deferredSpecifiers = [...DATA_LOADER_DEFERRED_SERVICE_IMPORTS, SIGNAL_AGGREGATOR_DEFERRED_SERVICE_IMPORT];
    const directOffenders = deferredSpecifiers.filter((specifier) => valueSpecifiers.includes(specifier));
    assert.deepEqual(
      directOffenders,
      [],
      'data-loader must not statically import RSS/trending/signal/daily-brief services; load them through cached import() helpers after first paint',
    );

    const dynamicSpecifiers = dynamicImportSpecifiers(source);
    for (const specifier of DATA_LOADER_DEFERRED_SERVICE_IMPORTS) {
      assert.ok(
        dynamicSpecifiers.includes(specifier),
        'data-loader should lazy-load ' + specifier + ' with import()',
      );
    }
  });

  it('keeps deferred modules out of the eager services barrel', () => {
    const barrel = stripComments(readFileSync(resolve(repoRoot, 'src/services/index.ts'), 'utf8'));
    for (const specifier of SERVICE_BARREL_DEFERRED_EXPORTS) {
      assert.doesNotMatch(
        barrel,
        new RegExp("\\bexport\\s+(?!type\\b)(?:\\*|\\{[\\s\\S]*?\\})\\s+from\\s+['\"]" + escapeRegExp(specifier) + "['\"]"),
        '@/services must not value-re-export ' + specifier + '; eager barrel consumers would pull it into main',
      );
    }
  });

  it('does not pull deferred exports through the eager services barrel import', () => {
    const servicesImportBlock = servicesBarrelValueImportBlock(withoutComments);
    const offenders = DATA_LOADER_DEFERRED_BARREL_EXPORTS.filter((name) => new RegExp(`\\b${name}\\b`).test(servicesImportBlock));
    assert.deepEqual(
      offenders,
      [],
      'RSS/trending/daily-brief exports pull deferred service modules into the eager data-loader graph; use cached import() helpers instead',
    );
  });

  it('clears cached lazy-load promises on rejection so later calls can retry', () => {
    for (const slot of DATA_LOADER_LAZY_PROMISE_SLOTS) {
      assert.ok(
        withoutComments.includes(`${slot} = null;`),
        `${slot} should be reset in its import().catch() path`,
      );
    }
  });
});

describe('main.js eager diet — eager UI keeps trending-keywords lazy', () => {
  it('does not statically import trending-keywords from the signal modal', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/SignalModal.ts'), 'utf8');
    assert.ok(
      !valueImportSpecifiers(stripComments(source)).includes('@/services/trending-keywords'),
      'SignalModal is imported by App at boot; suppressTrendingTerm should load through import() on user action',
    );
    assert.ok(
      dynamicImportSpecifiers(source).includes('@/services/trending-keywords'),
      'SignalModal should lazy-load trending-keywords when suppressing a term',
    );
  });
});

describe('main.js eager diet — export panel is interaction-loaded', () => {
  const eventHandlersSource = readFileSync(resolve(repoRoot, 'src/app/event-handlers.ts'), 'utf8');
  const eventHandlersWithoutComments = stripComments(eventHandlersSource);
  const utilsIndexSource = readFileSync(resolve(repoRoot, 'src/utils/index.ts'), 'utf8');

  it('checks every import block from the same specifier', () => {
    const source = [
      'import { buildMapUrl } from "@/utils";',
      'import { ExportPanel } from "@/utils";',
    ].join('\n');

    assert.match(valueImportBlock(source, '@/utils'), /\bExportPanel\b/);
  });

  it('does not import ExportPanel through the eager utils barrel', () => {
    assert.doesNotMatch(
      valueImportBlock(eventHandlersWithoutComments, '@/utils'),
      /\bExportPanel\b/,
      'event-handlers should not import ExportPanel from @/utils; it pulls export.ts into main.js',
    );
  });

  it('keeps ExportPanel behind a dynamic import and resets failed loads', () => {
    assert.ok(
      dynamicImportSpecifiers(eventHandlersSource).includes(EXPORT_PANEL_DEFERRED_IMPORT),
      'event-handlers should lazy-load ExportPanel with import("@/utils/export")',
    );
    assert.ok(
      eventHandlersWithoutComments.includes('exportPanelLoad = null;'),
      'event-handlers should reset exportPanelLoad on chunk-load failure so later Pro gates can retry',
    );
  });

  it('does not re-export export.ts from the eager utils barrel', () => {
    assert.doesNotMatch(
      stripComments(utilsIndexSource),
      /from\s+['"]\.\/export['"]/,
      'src/utils/index.ts should not re-export ./export into every @/utils importer',
    );
  });
});

describe('main.js eager diet — signal modal is interaction-loaded', () => {
  const appSource = readFileSync(resolve(repoRoot, 'src/App.ts'), 'utf8');
  const appWithoutComments = stripComments(appSource);

  it('does not statically import SignalModal into App boot', () => {
    assert.ok(
      !valueImportSpecifiers(appWithoutComments).includes(SIGNAL_MODAL_DEFERRED_IMPORT),
      'App should not statically import SignalModal; first show should lazy-load it',
    );
  });

  it('keeps SignalModal behind a dynamic import and resets failed loads', () => {
    assert.ok(
      appWithoutComments.includes("this.signalModalLoad = import('@/components/SignalModal')"),
      'App should lazy-load SignalModal with import("@/components/SignalModal")',
    );
    assert.ok(
      appWithoutComments.includes('signalModalLoad = null;'),
      'App should reset signalModalLoad on chunk-load failure so later notifications can retry',
    );
    assert.ok(
      !appWithoutComments.includes('this.state.signalModal = new SignalModal();'),
      'App should not construct SignalModal during boot',
    );
  });
});

describe('main.js eager diet — shared signal aggregation loader is lazy-loaded', () => {
  const source = readFileSync(resolve(repoRoot, 'src/app/lazy-services.ts'), 'utf8');

  it('keeps signal aggregation behind a dynamic import', () => {
    assert.ok(
      dynamicImportSpecifiers(source).includes(SIGNAL_AGGREGATOR_DEFERRED_SERVICE_IMPORT),
      'lazy-services should lazy-load signal-aggregator with import()',
    );
  });

  it('clears the cached signal-aggregator promise on rejection so later actions can retry', () => {
    assert.ok(
      stripComments(source).includes('signalAggregatorPromise = null;'),
      'lazy-services signalAggregatorPromise should be reset in its import().catch() path',
    );
  });
});

describe('main.js eager diet — structurally pinned service tail is lazy-loaded', () => {
  it('keeps military-vessels behind a shared dynamic import loader', () => {
    const source = readFileSync(resolve(repoRoot, 'src/services/military-vessels-lazy.ts'), 'utf8');
    assert.ok(
      dynamicImportSpecifiers(source).includes(MILITARY_VESSELS_DEFERRED_SERVICE_IMPORT),
      'military-vessels-lazy should lazy-load military-vessels with import()',
    );

    const dataLoaderSource = stripComments(readFileSync(resolve(repoRoot, 'src/app/data-loader.ts'), 'utf8'));
    assert.ok(
      !valueImportSpecifiers(dataLoaderSource).includes(MILITARY_VESSELS_DEFERRED_SERVICE_IMPORT),
      'data-loader must not value-import military-vessels directly',
    );
  });

  it('keeps the desktop findings badge and cross-module alerts behind dynamic imports', () => {
    const appSource = readFileSync(resolve(repoRoot, 'src/App.ts'), 'utf8');
    assert.ok(
      !valueImportSpecifiers(stripComments(appSource)).includes(INTELLIGENCE_GAP_BADGE_DEFERRED_IMPORT),
      'App must not statically import the findings badge into the main entry',
    );
    assert.ok(
      dynamicImportSpecifiers(appSource).includes(INTELLIGENCE_GAP_BADGE_DEFERRED_IMPORT),
      'App should lazy-load the findings badge on desktop',
    );

    const badgeSource = readFileSync(resolve(repoRoot, 'src/components/IntelligenceGapBadge.ts'), 'utf8');
    assert.ok(
      !valueImportSpecifiers(stripComments(badgeSource)).includes(CROSS_MODULE_DEFERRED_SERVICE_IMPORT),
      'IntelligenceGapBadge must not value-import cross-module-integration',
    );
    assert.ok(
      dynamicImportSpecifiers(badgeSource).includes(CROSS_MODULE_DEFERRED_SERVICE_IMPORT),
      'IntelligenceGapBadge should lazy-load cross-module alerts with import()',
    );
  });
});

describe('main.js eager diet — country-intel uses the shared signal aggregation loader', () => {
  const source = readFileSync(resolve(repoRoot, 'src/app/country-intel.ts'), 'utf8');
  const withoutComments = stripComments(source);

  it('does not value-import signal aggregation directly', () => {
    const valueSpecifiers = valueImportSpecifiers(withoutComments);
    assert.ok(
      !valueSpecifiers.includes(SIGNAL_AGGREGATOR_DEFERRED_SERVICE_IMPORT),
      'country-intel is part of the eager App graph; signal aggregation must load through the shared lazy helper',
    );
    assert.ok(
      valueSpecifiers.includes('@/app/lazy-services'),
      'country-intel should use the shared lazy-services getSignalAggregator helper',
    );
  });
});

describe('main.js eager diet — review feedback guards', () => {
  const dataLoaderSource = readFileSync(resolve(repoRoot, 'src/app/data-loader.ts'), 'utf8');
  const countryIntelSource = readFileSync(resolve(repoRoot, 'src/app/country-intel.ts'), 'utf8');
  const statusPanelSource = readFileSync(resolve(repoRoot, 'src/components/StatusPanel.ts'), 'utf8');
  const dataLoaderWithoutComments = stripComments(dataLoaderSource);
  const statusPanelWithoutComments = stripComments(statusPanelSource);

  it('shows a loading brief before waiting on lazy country signals', () => {
    const openStart = countryIntelSource.indexOf('async openCountryBriefByCode');
    const loadingIndex = countryIntelSource.indexOf('page.showLoading();', openStart);
    const signalsIndex = countryIntelSource.indexOf('const signals = await this.getCountrySignals(code, country);', openStart);
    assert.ok(openStart >= 0, 'openCountryBriefByCode should exist');
    assert.ok(loadingIndex > openStart, 'openCountryBriefByCode should show the loading shell');
    assert.ok(signalsIndex > loadingIndex, 'openCountryBriefByCode should show loading before lazy signal aggregation');
  });

  it('keeps country signals resilient to signal-aggregator chunk failures', () => {
    const signalsStart = countryIntelSource.indexOf('async getCountrySignals');
    const signalsEnd = countryIntelSource.indexOf('const globalTemporalAnomalies', signalsStart);
    const signalSetup = countryIntelSource.slice(signalsStart, signalsEnd);
    assert.match(signalSetup, /let\s+clusters:\s+CountrySignalCluster\[\]\s*=\s*\[\];/);
    assert.match(signalSetup, /try\s*\{[\s\S]*getSignalAggregator\(\)[\s\S]*\}\s*catch/);
    assert.match(signalSetup, /signal clusters unavailable, degrading/);
  });

  it('surfaces signal-aggregator chunk failures in the status panel', () => {
    assert.match(dataLoaderWithoutComments, /statusPanel\?\.updateApi\('Signal Aggregator',\s*\{\s*status:\s*'error'/);
    assert.doesNotMatch(
      dataLoaderWithoutComments,
      /await\s+runSignalAggregator\(\s*['"]/,
      'runSignalAggregator call sites should pass statusPanel so lazy chunk failures are visible to ops',
    );
  });

  it('allows Signal Aggregator API status updates to be recorded', () => {
    const signalAggregatorOccurrences = (statusPanelWithoutComments.match(/'Signal Aggregator'/g) ?? []).length;
    assert.equal(signalAggregatorOccurrences, 2, 'Signal Aggregator should be allowlisted for tech and world variants');
    assert.match(statusPanelWithoutComments, /interface\s+ApiStatus\s*\{[\s\S]*errorMessage\?:\s*string/);
  });
});
