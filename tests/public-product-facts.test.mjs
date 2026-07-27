import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));

const registryToolNames = () => TOOL_REGISTRY.map((tool) => tool.name);
const registryToolCount = () => TOOL_REGISTRY.length;
const displayPrice = (price) => (Number.isInteger(price) ? String(price) : price.toFixed(2));

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
  'public/pro/assets/',
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
  it('publishes generated lifecycle, pricing, and capability facts', () => {
    const sharedFacts = readJson('shared/product-facts.generated.json');
    const publicFacts = readJson('public/product-facts.json');

    assert.deepEqual(publicFacts, sharedFacts);
    assert.equal(sharedFacts.product.lifecycle, 'launched');
    assert.equal(sharedFacts.product.pricingUrl, 'https://www.worldmonitor.app/pro#pricing');
    assert.equal(sharedFacts.product.primaryCtaLabel, 'View Pro plans');
    assert.equal(sharedFacts.currency, 'USD');
    assert.equal(sharedFacts.capabilities.mcpTools, registryToolCount());
    const serverCardNames = readJson('public/.well-known/mcp/server-card.json')
      .tools
      .map((tool) => tool.name);
    assert.deepEqual(serverCardNames.sort(), registryToolNames().sort());
    assert.equal(readJson('docs/generated/stats.json').mcpToolCount, registryToolCount());
    assert.equal(readJson('public/agent-view.json').endpoints.mcp.tools, registryToolCount());
    for (const localePath of [
      'pro-test/src/locales/en.json',
      'pro-test/src/locales/fa.json',
    ]) {
      assert.equal(
        Number(readJson(localePath).welcome.depth.s12v),
        registryToolCount(),
        `${localePath} publishes a stale MCP depth statistic`,
      );
    }

    const proMonthly = sharedFacts.plans.find((plan) => plan.planKey === 'pro_monthly');
    const proAnnual = sharedFacts.plans.find((plan) => plan.planKey === 'pro_annual');
    assert.equal(proMonthly.price, PRODUCT_CATALOG.pro_monthly.priceCents / 100);
    assert.equal(proMonthly.billingDuration, 'P1M');
    assert.equal(proAnnual.price, PRODUCT_CATALOG.pro_annual.priceCents / 100);
    assert.equal(proAnnual.billingDuration, 'P1Y');
    for (const plan of sharedFacts.plans.filter((candidate) => candidate.price != null)) {
      assert.equal(plan.priceCurrency, 'USD');
      assert.equal(plan.availability, 'https://schema.org/InStock');
      assert.equal(plan.url, sharedFacts.product.pricingUrl);
    }
  });

  it('keeps every exact MCP count on a current public surface aligned to the registry', () => {
    const expected = registryToolCount();
    let claimCount = 0;
    for (const path of CURRENT_FACT_SURFACES) {
      const source = read(path);
      const claims = [
        ...source.matchAll(/\b(\d+)(?=-tool MCP server\b)/g),
        ...source.matchAll(/\b(\d+)(?=\s+MCP tools\b)/g),
        ...source.matchAll(/\b(\d+)(?=\s+(?:live\s+)?(?:geopolitical intelligence\s+)?tools\b)/g),
        ...source.matchAll(/\b(\d+)\+(?=\s+(?:MCP\s+)?tools\b)/g),
        ...source.matchAll(/\b(\d+)(?=\s+\[MCP tools\])/g),
        ...source.matchAll(/\b(\d+)(?=\s+tool definitions\b)/g),
        ...source.matchAll(/\b(\d+)(?=\s*个\s*(?:MCP\s*)?(?:实时|压缩的)?工具)/g),
      ];
      for (const claim of claims) {
        claimCount += 1;
        assert.equal(Number(claim[1]), expected, `${path} publishes a stale MCP tool count`);
      }
    }
    assert.ok(claimCount >= 25, 'expected exact MCP counts across the public acquisition corpus');
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
    for (const path of ['pro-test/prerender.mjs', 'public/pro/index.html', 'public/pro/welcome.html']) {
      const source = read(path);
      assert.match(source, new RegExp(`\\$${proMonthly.replace('.', '\\.')}[^\\d]`), `${path}: Pro monthly`);
      assert.match(source, new RegExp(`\\$${proAnnual.replace('.', '\\.')}[^\\d]`), `${path}: Pro annual`);
    }
    assert.match(read('pro-test/welcome.html'), new RegExp(`\\$${proMonthly.replace('.', '\\.')}[^\\d]`));

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

  it('publishes valid, available, canonical offers in source and committed HTML', () => {
    const facts = readJson('shared/product-facts.generated.json');
    const pricingUrl = facts.product.pricingUrl;
    const plansByName = new Map(facts.plans.map((plan) => [plan.name, plan]));
    for (const path of [
      'index.html',
      'pro-test/index.html',
      'pro-test/welcome.html',
      'public/pro/index.html',
      'public/pro/welcome.html',
    ]) {
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

  it('keeps committed generated facts fresh', () => {
    assert.doesNotThrow(() => {
      execFileSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/generate-public-product-facts.mjs', '--check'],
        { cwd: ROOT, stdio: 'pipe' },
      );
    });
  });
});
