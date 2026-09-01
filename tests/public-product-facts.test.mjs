import { describe, it } from 'node:test';
import { guardProBuiltOutput, withoutUnbuiltProPaths } from './_lib/pro-built-output.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';
import {
  ACQUISITION_CLAIM_ROOTS,
  collectCurrentAcquisitionClaimFiles,
  computeStats,
  retainedExactContractCoverageFailures,
  validateVolatileInventoryClaims,
  VOLATILE_INVENTORY_CLAIM_RE,
} from '../scripts/docs-stats.mjs';
import { buildInventoryFacts, generateInventoryFacts, loadStatsForInventoryFacts } from '../scripts/generate-inventory-facts.mjs';
import { buildSourceAttributionStats, checkSourceAttribution } from '../scripts/source-attribution.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));

function makeAttributionFixture({ kind = 'structured', references = [{ path: 'scripts/stale-source.mjs' }] } = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'wm-attribution-fixture-'));
  for (const path of ['api', 'docs', 'scripts', 'server', 'shared', 'src']) {
    mkdirSync(join(fixtureRoot, path), { recursive: true });
  }
  writeFileSync(join(fixtureRoot, 'scripts/live-source.mjs'), "export const DATA_URL = 'https://upstream.example/data';\n");
  writeFileSync(join(fixtureRoot, 'docs/source-attribution.mdx'), '# Attribution\n');
  writeFileSync(join(fixtureRoot, 'shared/source-attribution-manifest.json'), `${JSON.stringify({
    version: 1,
    entries: [{
      host: 'upstream.example',
      provider: 'upstream.example',
      license: 'Provider terms',
      attribution: 'Credit upstream.example.',
      observed: true,
      kind,
      status: 'reviewed',
      references,
    }],
    logicalEntries: [],
  }, null, 2)}\n`);
  return fixtureRoot;
}

function inventoryStatsFromAttributionFixture(fixtureRoot, warnings) {
  const baseStats = computeStats();
  return () => loadStatsForInventoryFacts({
    compute: ({ sourceAttribution } = {}) => {
      const attribution = sourceAttribution
        ?? buildSourceAttributionStats({ rootDir: fixtureRoot });
      return {
        ...baseStats,
        sourceAttribution: attribution,
        sourceAttributionHosts: attribution.activeHosts,
      };
    },
    fallbackAttribution: () => buildSourceAttributionStats({ rootDir: fixtureRoot, validate: false }),
    warn: (message) => warnings.push(message),
  });
}

const registryToolNames = () => TOOL_REGISTRY.map((tool) => tool.name);
const registryToolCount = () => TOOL_REGISTRY.length;
const advertisedAgentCardToolCount = () => {
  const routingSkill = readJson('public/.well-known/agent-card.json').skills
    ?.find((skill) => skill.id === 'route-to-tool');
  assert.ok(routingSkill?.description, 'A2A routing skill must have a description');
  const count = routingSkill.description.match(/\b(\d+)-tool catalog\b/);
  assert.ok(count, 'A2A routing skill must advertise an N-tool catalog');
  return Number.parseInt(count[1], 10);
};
const displayPrice = (price) => (Number.isInteger(price) ? String(price) : price.toFixed(2));

const REQUIRED_ACQUISITION_CLAIM_ROOTS = [
  'README.ja-JP.md',
  'README.md',
  'README.zh-CN.md',
  'blog-site/src/content/blog',
  'cli',
  'docs',
  'index.html',
  'pro-test/index.html',
  'pro-test/src/locales',
  'pro-test/welcome.html',
  'public',
  'public/.well-known/agent-skills',
  'public/.well-known/ai-catalog.json',
  'public/api/llms.txt',
  'scripts/build-agent-skills-index.mjs',
  'server.json',
];

function assertAcquisitionClaimRootClosure(actualRoots) {
  assert.deepEqual([...actualRoots].sort(), REQUIRED_ACQUISITION_CLAIM_ROOTS);
}

const REQUIRED_CURRENT_DOC_EXCLUDES = [
  'docs/Docs_To_Review/',
  'docs/api/',
  'docs/archive/',
  'docs/audits/',
  'docs/brainstorms/',
  'docs/generated/',
  'docs/ideation/',
  'docs/internal/',
  'docs/perf/',
  'docs/plans/',
  'docs/research/',
  'docs/solutions/',
];

function independentlyCollectCurrentDocs() {
  const paths = [];
  const visit = (path) => {
    if (REQUIRED_CURRENT_DOC_EXCLUDES.some((prefix) => path.startsWith(prefix))) return;
    if (['docs/changelog.mdx', 'docs/desktop-parity-matrix.md', 'docs/railway-seed-consolidation-runbook.md', 'docs/source-attribution.mdx', 'docs/zh/changelog.mdx'].includes(path)) return;
    const stat = statSync(join(ROOT, path));
    if (stat.isDirectory()) {
      for (const entry of readdirSync(join(ROOT, path))) visit(`${path}/${entry}`);
      return;
    }
    if (/\.(?:md|mdx)$/.test(path)) paths.push(path);
  };
  visit('docs');
  return paths.sort();
}

function machineReadablePricing() {
  const match = read('public/pricing.md').match(
    /## Machine-Readable Summary[\s\S]*?```json\n([\s\S]*?)\n```/,
  );
  assert.ok(match, 'public/pricing.md must publish a machine-readable pricing summary');
  return JSON.parse(match[1]);
}

function applicationJsonLd(path) {
  const blocks = [...read(path).matchAll(
    /<script\b(?=[^>]*\btype="application\/ld\+json")[^>]*>\s*([\s\S]*?)\s*<\/script>/g,
  )].map((match) => JSON.parse(match[1]));
  const application = blocks.find((block) => (
    block['@type'] === 'SoftwareApplication' || block['@type'] === 'WebApplication'
  ));
  assert.ok(application, `${path} must publish application JSON-LD`);
  return application;
}

const ACQUISITION_ROOTS = [
  'index.html',
  'README.md',
  'README.zh-CN.md',
  'server.json',
  'cli',
  'docs',
  'public',
  'pro-test',
  'blog-site/src',
];

const ACQUISITION_EXTENSIONS = /\.(?:astro|html|json|md|mdx|mjs|txt)$/;
const ACQUISITION_EXCLUDES = [
  'blog-site/node_modules/',
  'docs/Docs_To_Review/',
  'docs/api/',
  'docs/archive/',
  'docs/brainstorms/',
  'docs/ideation/',
  'docs/internal/',
  'docs/plans/',
  'pro-test/node_modules/',
  'public/blog/',
  // public/pro/ joins public/blog/ here for the same reason (#6898): both are
  // BUILT output, so a filesystem walk would silently scan a larger or smaller
  // population depending on whether someone ran the build -- shrinking the
  // surface set without ever reporting a skip. The sources these compile from
  // (pro-test/index.html, pro-test/welcome.html, pro-test/src/locales/) are
  // committed and stay in scope, so nothing is actually left unchecked.
  'public/pro/',
  'public/openapi',
];

function collectAcquisitionSurfaces() {
  const surfaces = [];
  const visit = (path) => {
    if (ACQUISITION_EXCLUDES.some((prefix) => path.startsWith(prefix))) return;
    const fullPath = join(ROOT, path);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(fullPath)) visit(`${path}/${entry}`);
    } else if (ACQUISITION_EXTENSIONS.test(path)) {
      surfaces.push(path);
    }
  };
  for (const path of ACQUISITION_ROOTS) visit(path);
  return surfaces.sort();
}

const CURRENT_FACT_SURFACES = collectAcquisitionSurfaces();
describe('public product facts generation contract', () => {
  // Two cases below read the built public/pro/ pages, which `npm run build:pro`
  // produces rather than git (#6898). They drop those paths in an unbuilt
  // checkout; this makes CI fail instead when it says it built them.
  guardProBuiltOutput();

  it('keeps the acquisition claim scan on the complete registered root set', () => {
    assertAcquisitionClaimRootClosure(ACQUISITION_CLAIM_ROOTS);
    assert.throws(
      () => assertAcquisitionClaimRootClosure(
        ACQUISITION_CLAIM_ROOTS.filter((path) => path !== 'README.ja-JP.md'),
      ),
      /Expected values to be strictly deep-equal/,
      'deleting one registered acquisition root must fail closed',
    );
  });

  it('keeps recursive current documentation in the exact acquisition scan closure', () => {
    const expected = independentlyCollectCurrentDocs();
    const actual = collectCurrentAcquisitionClaimFiles().filter((path) => path.startsWith('docs/'));
    assert.deepEqual(actual, expected);
    assert.ok(actual.includes('docs/panels/news-feeds.mdx'), 'nested panel docs must be scanned');
    assert.throws(
      () => assert.deepEqual(actual.filter((path) => path !== 'docs/panels/news-feeds.mdx'), expected),
      /Expected values to be strictly deep-equal/,
      'deleting one nested current documentation surface must fail closed',
    );
  });

  it('fails closed when a retained exact contract disappears', () => {
    const contract = { path: 'docs/fixed-protocol.mdx', text: /six fixed fields/ };
    assert.deepEqual(retainedExactContractCoverageFailures([contract], new Set([contract])), []);
    assert.deepEqual(
      retainedExactContractCoverageFailures([contract], new Set()),
      ['docs/fixed-protocol.mdx: retained exact count contract is missing or changed: /six fixed fields/'],
    );
  });

  it('fails closed when any published inventory extractor collapses to zero', () => {
    const stats = computeStats();
    const capabilityStatKeys = [
      'mcpToolCount',
      'locales',
      'variantCount',
      'layerDefinitions',
      'panelClasses',
      'feedDefinitions',
      'freshnessSources',
      'sourceAttributionHosts',
    ];
    for (const key of capabilityStatKeys) {
      assert.throws(
        () => buildInventoryFacts({ ...stats, [key]: 0 }),
        /must be a positive integer/,
        `${key} parser collapse must fail generation`,
      );
    }
    assert.throws(
      () => buildInventoryFacts({
        ...stats,
        sourceAttribution: { ...stats.sourceAttribution, providerCount: 0 },
      }),
      /must be a positive integer/,
      'provider parser collapse must fail generation',
    );
    assert.throws(
      () => buildInventoryFacts({ ...stats, localeCodes: [] }),
      /localeCodes must be a non-empty unique locale-code registry/,
      'locale membership extraction must not collapse while its count stays positive',
    );
  });

  it('fails the inventory check for missing or stale build outputs', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-inventory-facts-'));
    mkdirSync(join(tempRoot, 'api'));
    mkdirSync(join(tempRoot, 'public'));
    const expected = new Map([
      ['api/_inventory-facts.generated.js', 'edge'],
      ['public/product-facts.json', 'public'],
    ]);
    try {
      assert.throws(
        () => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }),
        /missing or stale: api\/_inventory-facts\.generated\.js, public\/product-facts\.json/,
      );
      generateInventoryFacts({ outputs: expected, rootDir: tempRoot });
      assert.doesNotThrow(() => (
        generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot })
      ));
      writeFileSync(join(tempRoot, 'api/_inventory-facts.generated.js'), 'stale');
      assert.throws(
        () => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }),
        /missing or stale: api\/_inventory-facts\.generated\.js/,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('stops consumers on an interrupted publication and repairs it on the next run', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-inventory-facts-interrupted-'));
    mkdirSync(join(tempRoot, 'api'));
    mkdirSync(join(tempRoot, 'public'));
    const expected = new Map([
      ['api/_inventory-facts.generated.js', 'edge'],
      ['public/product-facts.json', 'public'],
    ]);
    let renames = 0;
    let consumerRan = false;
    const interruptedFileOps = {
      mkdirSync,
      writeFileSync,
      unlinkSync,
      renameSync(from, to) {
        renames += 1;
        if (renames === 2) throw new Error('simulated publication interruption');
        renameSync(from, to);
      },
    };
    try {
      assert.throws(() => {
        generateInventoryFacts({ outputs: expected, rootDir: tempRoot, fileOps: interruptedFileOps });
        consumerRan = true;
      }, /simulated publication interruption/);
      assert.equal(consumerRan, false, 'a failed generator must stop the next consumer command');
      assert.equal(readFileSync(join(tempRoot, 'api/_inventory-facts.generated.js'), 'utf8'), 'edge');
      assert.equal(existsSync(join(tempRoot, `public/product-facts.json.tmp-${process.pid}`)), false);
      assert.throws(
        () => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }),
        /public\/product-facts\.json/,
      );
      generateInventoryFacts({ outputs: expected, rootDir: tempRoot });
      assert.doesNotThrow(() => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('publishes all default inventory outputs from a stale but structurally valid attribution ledger', () => {
    const warnings = [];
    const fixtureRoot = makeAttributionFixture();
    const publishRoot = mkdtempSync(join(tmpdir(), 'wm-inventory-default-publication-'));
    try {
      const strict = checkSourceAttribution(fixtureRoot);
      assert.ok(strict.errors.length > 0, 'strict source attribution checking must remain red for parity drift');
      assert.match(strict.errors.join('\n'), /stale manifest entry/);

      const loadStats = inventoryStatsFromAttributionFixture(fixtureRoot, warnings);
      generateInventoryFacts({ rootDir: publishRoot, loadStats });
      for (const path of [
        'public/product-facts.json',
        'scripts/shared/inventory-facts.generated.json',
        'api/_inventory-facts.generated.js',
        'docs/generated/stats.json',
      ]) {
        assert.ok(existsSync(join(publishRoot, path)), `default generator did not publish ${path}`);
      }
      assert.doesNotThrow(() => generateInventoryFacts({ check: true, rootDir: publishRoot, loadStats }));
      assert.match(warnings.join('\n'), /proceeding with committed attribution counts/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(publishRoot, { recursive: true, force: true });
    }
  });

  it('does not swallow non-attribution inventory failures', () => {
    assert.throws(
      () => loadStatsForInventoryFacts({
        compute: () => {
          throw new Error('docs-stats: could not isolate STOCK_EXCHANGES block');
        },
      }),
      /STOCK_EXCHANGES/,
    );
  });

  it('does not publish inventory outputs from a malformed attribution ledger', () => {
    const warnings = [];
    const fixtureRoot = makeAttributionFixture({ kind: 'not-a-source-kind' });
    const publishRoot = mkdtempSync(join(tmpdir(), 'wm-inventory-invalid-ledger-'));
    try {
      const strict = checkSourceAttribution(fixtureRoot);
      assert.ok(strict.errors.length > 0, 'strict source attribution checking must reject malformed ledger entries');
      assert.match(strict.errors.join('\n'), /invalid manifest kind/);

      assert.throws(
        () => generateInventoryFacts({
          rootDir: publishRoot,
          loadStats: inventoryStatsFromAttributionFixture(fixtureRoot, warnings),
        }),
        /invalid manifest kind/,
      );
      for (const path of [
        'public/product-facts.json',
        'scripts/shared/inventory-facts.generated.json',
        'api/_inventory-facts.generated.js',
        'docs/generated/stats.json',
      ]) {
        assert.equal(existsSync(join(publishRoot, path)), false, `malformed ledger published ${path}`);
      }
      assert.equal(warnings.length, 0, 'a malformed ledger must not emit a proceeding warning');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(publishRoot, { recursive: true, force: true });
    }
  });

  it('keeps stable product facts separate from build-owned inventory facts', () => {
    const stableFacts = readJson('shared/product-facts.generated.json');
    const publicFacts = readJson('public/product-facts.json');
    const relayInventory = readJson('scripts/shared/inventory-facts.generated.json');
    const stats = computeStats();

    assert.equal(stableFacts.capabilities, undefined);
    assert.equal(readJson('shared/product-catalog.generated.json').facts.capabilities, undefined);
    assert.deepEqual(
      Object.fromEntries(Object.entries(publicFacts).filter(([key]) => key !== 'capabilities')),
      stableFacts,
    );
    assert.deepEqual(publicFacts.capabilities, relayInventory.capabilities);
    assert.deepEqual(publicFacts.capabilities, {
      mcpTools: stats.mcpToolCount,
      locales: stats.locales,
      variants: stats.variantCount,
      mapLayers: stats.layerDefinitions,
      panelImplementations: stats.panelClasses,
      feedDefinitions: stats.feedDefinitions,
      freshnessTrackedSourceGroups: stats.freshnessSources,
      sourceAttributionHosts: stats.sourceAttributionHosts,
      sourceAttributionProviders: stats.sourceAttribution.providerCount,
      localeCodes: stats.localeCodes,
    });
    assert.equal(stableFacts.product.lifecycle, 'launched');
    assert.equal(stableFacts.product.pricingUrl, 'https://www.worldmonitor.app/pro#pricing');
    assert.equal(stableFacts.product.primaryCtaLabel, 'View Pro plans');
    assert.equal(stableFacts.currency, 'USD');
    const serverCardNames = readJson('public/.well-known/mcp/server-card.json')
      .tools
      .map((tool) => tool.name);
    assert.deepEqual(serverCardNames.sort(), registryToolNames().sort());
    assert.equal(stats.mcpToolCount, registryToolCount());

    const proMonthly = stableFacts.plans.find((plan) => plan.planKey === 'pro_monthly');
    const proAnnual = stableFacts.plans.find((plan) => plan.planKey === 'pro_annual');
    assert.equal(proMonthly.price, PRODUCT_CATALOG.pro_monthly.priceCents / 100);
    assert.equal(proMonthly.billingDuration, 'P1M');
    assert.equal(proAnnual.price, PRODUCT_CATALOG.pro_annual.priceCents / 100);
    assert.equal(proAnnual.billingDuration, 'P1Y');
    for (const plan of stableFacts.plans.filter((candidate) => candidate.price != null)) {
      assert.equal(plan.priceCurrency, 'USD');
      assert.equal(plan.availability, 'https://schema.org/InStock');
      assert.equal(plan.url, stableFacts.product.pricingUrl);
    }
  });

  it('keeps the A2A routing card tool count aligned with the live registry', () => {
    assert.equal(advertisedAgentCardToolCount(), registryToolCount());
  });

  it('removes stale waitlist lifecycle terms from current acquisition surfaces', () => {
    const banned = /Pro \(Waitlist\)|Get Early Access|pro#waitlist/;
    for (const path of CURRENT_FACT_SURFACES) {
      assert.doesNotMatch(read(path), banned, `${path} still publishes a pre-launch lifecycle term`);
    }

    const localePaths = readdirSync(join(ROOT, 'pro-test/src/locales'))
      .filter((name) => name.endsWith('.json'));
    for (const name of localePaths) {
      const locale = readJson(`pro-test/src/locales/${name}`);
      assert.equal(locale.nav?.reserveAccess, undefined, `${name}: legacy nav waitlist CTA`);
      assert.equal(locale.hero?.reserveEarlyAccess, undefined, `${name}: legacy hero waitlist CTA`);
      assert.equal(locale.hero?.emailPlaceholder, undefined, `${name}: legacy waitlist email field`);
      assert.equal(locale.hero?.emailAriaLabel, undefined, `${name}: legacy waitlist email label`);
      assert.equal(locale.twoPath?.proCta, undefined, `${name}: legacy product waitlist CTA`);
      assert.equal(locale.finalCta?.getPro, undefined, `${name}: legacy final waitlist CTA`);
      assert.equal(locale.footer?.beFirstInLine, undefined, `${name}: legacy queue copy`);
      assert.equal(locale.form, undefined, `${name}: legacy waitlist form copy`);
      assert.equal(locale.referral, undefined, `${name}: legacy waitlist referral copy`);
    }
  });

  it('keeps volatile inventory totals out of hand-authored acquisition copy', () => {
    const violations = validateVolatileInventoryClaims();
    assert.deepEqual(
      violations,
      [],
      `hand-authored acquisition copy must use registry-derived or semantic inventory wording:\n${violations.join('\n')}`,
    );
    for (const claim of [
      '30+ live services',
      '500+ curated news feeds',
      '25+ other live services',
      '12+ data source credentials',
      'MCP offers 52 tools',
      'There are 445 API handlers',
      '80+ Vercel Edge Functions',
      '190+ documented operations',
      '24 typed services',
      '26 OSINT channels',
      '31 live webcams',
      'seven live news channels',
      'Panels: 102',
      'six specialized variants',
      'five dashboard variants',
      'five interchangeable surfaces',
      '34 proto-backed domains',
      '27 positive-news feeds',
      '28 supported languages',
      '44 data layers',
      '44 other intelligence layers',
      '20+ separate services',
      '| Live video streams | 8 |',
      '| Languages supported | 27 (including RTL) |',
      '| Airports monitored | 111 |',
      '52個のMCPツール',
      '52個のMCPツールも使える',
      '52個のMCPツールから選べる',
      '52個のMCPツールまで対応',
      '52個のMCPツールより多い',
      '60以上のVercel Edge Functions',
      '6つのダッシュボード',
      '313のAIデータセンターを電力・運営者メタデータ付きでマッピング',
      '26 个 OSINT 频道',
      '210+ military bases',
      '38+ associated military bases',
      '9 strategic theaters',
      '210+ 基地数据库',
      '56-channel Telegram OSINT feed',
      '62 strategic ports',
      '88 mapped pipelines',
      '13 monitored waterways',
      '~100 tracked satellites',
      '80–120 intelligence satellites',
      '25 installable agent skills',
      '跨 30+ 实时服务',
      '500 多个实时数据源',
      '25 个可安装智能体技能',
      '25 个公开智能体配方',
      'Vercel Edge Functions（60+）',
      'Vercel Edge Functions (60 以上)',
    ]) {
      assert.match(claim, VOLATILE_INVENTORY_CLAIM_RE, `modifier form must remain guarded: ${claim}`);
    }
  });

  it('keeps user-visible prices aligned with generated plan facts', () => {
    const facts = readJson('shared/product-facts.generated.json');
    const plans = Object.fromEntries(facts.plans.map((plan) => [plan.planKey, plan]));
    const tiers = Object.fromEntries(
      readJson('pro-test/src/generated/tiers.json').map((tier) => [tier.localeKey, tier]),
    );

    assert.equal(tiers.pro.monthlyPrice, plans.pro_monthly.price);
    assert.equal(tiers.pro.annualPrice, plans.pro_annual.price);
    assert.equal(tiers.api.monthlyPrice, plans.api_starter.price);
    assert.equal(tiers.api.annualPrice, plans.api_starter_annual.price);
    assert.equal(tiers.apiBusiness.monthlyPrice, plans.api_business.price);

    const localePaths = readdirSync(join(ROOT, 'pro-test/src/locales'))
      .filter((name) => name.endsWith('.json'));
    for (const name of localePaths) {
      const table = readJson(`pro-test/src/locales/${name}`).pricingTable;
      const proPrice = Number(table.proHeader.match(/\$([0-9.,]+)/)?.[1].replace(',', '.'));
      const apiPrice = Number(table.apiHeader.match(/\$([0-9.,]+)/)?.[1].replace(',', '.'));
      assert.equal(proPrice, plans.pro_monthly.price, `${name}: visible Pro table price`);
      assert.equal(apiPrice, plans.api_starter.price, `${name}: visible API table price`);
    }

    const proMonthly = displayPrice(plans.pro_monthly.price);
    const proAnnual = displayPrice(plans.pro_annual.price);
    const apiMonthly = displayPrice(plans.api_starter.price);
    const apiAnnual = displayPrice(plans.api_starter_annual.price);
    const businessMonthly = displayPrice(plans.api_business.price);
    // The Pro app reads the generated tier values asserted above; the welcome
    // source and its built SSR output also surface the monthly entry price.
    // Do not require the prerender script to carry a second crawler-only copy.
    for (const path of withoutUnbuiltProPaths(['pro-test/welcome.html', 'public/pro/welcome.html'])) {
      assert.match(read(path), new RegExp(`\\$${proMonthly.replace('.', '\\.')}[^\\d]`), `${path}: Pro monthly`);
    }

    for (const path of ['docs/pricing.mdx', 'docs/zh/pricing.mdx', 'public/pricing.md']) {
      const source = read(path);
      for (const price of [proMonthly, proAnnual, apiMonthly, apiAnnual, businessMonthly]) {
        assert.match(source, new RegExp(`\\$${price.replace('.', '\\.')}[^\\d]`), `${path}: $${price}`);
      }
    }

    const summaryPlans = Object.fromEntries(
      machineReadablePricing().plans.map((plan) => [plan.name, plan]),
    );
    assert.equal(summaryPlans.Pro.price_usd_monthly, plans.pro_monthly.price);
    assert.equal(summaryPlans.Pro.price_usd_yearly, plans.pro_annual.price);
    assert.equal(summaryPlans.API.price_usd_monthly, plans.api_starter.price);
    assert.equal(summaryPlans.API.price_usd_yearly, plans.api_starter_annual.price);
    assert.equal(summaryPlans['API Business'].price_usd_monthly, plans.api_business.price);
  });

  it('publishes valid, available, canonical offers in source and built HTML', () => {
    const facts = readJson('shared/product-facts.generated.json');
    const pricingUrl = facts.product.pricingUrl;
    const plansByName = new Map(facts.plans.map((plan) => [plan.name, plan]));
    for (const path of withoutUnbuiltProPaths([
      'index.html',
      'pro-test/index.html',
      'pro-test/welcome.html',
      'public/pro/index.html',
      'public/pro/welcome.html',
    ])) {
      const application = applicationJsonLd(path);
      assert.ok(Array.isArray(application.offers) && application.offers.length >= 3);
      for (const offer of application.offers) {
        const expected = plansByName.get(offer.name);
        assert.ok(expected, `${path}: ${offer.name} must map to a generated public plan`);
        assert.equal(offer.priceCurrency, 'USD', `${path}: ${offer.name} currency`);
        assert.equal(offer.availability, 'https://schema.org/InStock', `${path}: ${offer.name} availability`);
        assert.equal(offer.url, pricingUrl, `${path}: ${offer.name} canonical pricing URL`);
        assert.equal(Number(offer.price), expected.price, `${path}: ${offer.name} price`);
        if (Number(offer.price) > 0) {
          assert.equal(
            offer.priceSpecification?.billingDuration,
            expected.billingDuration,
            `${path}: ${offer.name} billing duration`,
          );
          assert.equal(offer.priceSpecification.priceCurrency, offer.priceCurrency);
          assert.equal(Number(offer.priceSpecification.price), Number(offer.price));
        }
      }
    }
  });

  it('keeps stable and build-owned generated facts fresh', () => {
    assert.doesNotThrow(() => {
      execFileSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/generate-public-product-facts.mjs', '--check'],
        { cwd: ROOT, stdio: 'pipe' },
      );
      execFileSync(
        process.execPath,
        ['scripts/generate-inventory-facts.mjs', '--check'],
        { cwd: ROOT, stdio: 'pipe' },
      );
    });
  });
});
