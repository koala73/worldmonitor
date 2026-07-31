import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  CHINA_MACRO_REQUIRED_SERIES,
  CHINA_MACRO_SERIES_CONTRACT,
} from '../shared/china-macro-contract.js';
import {
  CHINA_CORRIDOR_SIGNAL_FAMILIES,
  CHINA_LOGISTICS_CORRIDORS,
} from '../shared/china-logistics-corridors';
import {
  OFFICIAL_EXCHANGE_SOURCE_CONTRACTS,
  REVIEWED_DISCLOSURE_ISSUERS,
} from '../scripts/china-corporate-disclosures/adapters.mjs';
import { CHINA_COVERAGE_ENTRIES } from '../scripts/china-coverage-manifest.mjs';
import { CHINA_POLICY_SOURCES } from '../scripts/china-policy/adapters.mjs';
import { CHINA_POLICY_AGENCIES } from '../scripts/china-policy/normalize.mjs';

// The seeder resolves REQUEST_BUDGET from COMTRADE_REQUEST_BUDGET at module
// evaluation, while the docs state the default contract. Clear the override
// before a lazy import so an operator env cannot fail the docs assertion.
delete process.env.COMTRADE_REQUEST_BUDGET;
const { MIN_COUNTRY_COVERAGE, REQUEST_BUDGET } = await import(
  '../scripts/seed-comtrade-bilateral-hs4.mjs'
);

const root = resolve(import.meta.dirname, '..');
const read = (relativePath: string) =>
  readFileSync(resolve(root, relativePath), 'utf8').replaceAll('\r\n', '\n');

const docsConfig = JSON.parse(read('docs/docs.json'));

function collectPagePaths(node: unknown, pages: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectPagePaths(item, pages);
    return pages;
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (typeof record.pages === 'string') pages.push(record.pages);
    if (Array.isArray(record.pages)) {
      for (const page of record.pages) {
        if (typeof page === 'string') pages.push(page);
        else collectPagePaths(page, pages);
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'pages' && value && typeof value === 'object') {
        collectPagePaths(value, pages);
      }
    }
  }
  return pages;
}

const englishNavigation = docsConfig.navigation.languages.find(
  (entry: { language?: string }) => entry.language === 'en',
);
const chineseNavigation = docsConfig.navigation.languages.find(
  (entry: { language?: string }) => entry.language === 'zh-Hans',
);
const englishPages = new Set(collectPagePaths(englishNavigation));
const chinesePages = new Set(collectPagePaths(chineseNavigation));

const CHINA_DOC_PAGES = [
  'china-data-coverage',
  'china-official-macro-policy',
  'china-corporate-disclosures',
  'china-logistics-corridors',
  'china-decision-signals',
  'decision-signal-provenance',
  'methodology/china-activity-nowcast',
] as const;
function assertIncludesEvery(content: string, values: readonly string[], label: string) {
  const missing = values.filter((value) => !content.includes(value));
  assert.deepEqual(missing, [], `${label} is missing: ${missing.join(', ')}`);
}

describe('China documentation contract', () => {
  it('keeps every China capability page discoverable in English and Chinese navigation', () => {
    for (const page of CHINA_DOC_PAGES) {
      assert.ok(englishPages.has(page), `English navigation is missing ${page}`);
      assert.ok(chinesePages.has(`zh/${page}`), `Chinese navigation is missing zh/${page}`);
      assert.ok(existsSync(resolve(root, `docs/${page}.mdx`)), `Missing docs/${page}.mdx`);
      assert.ok(existsSync(resolve(root, `docs/zh/${page}.mdx`)), `Missing docs/zh/${page}.mdx`);
    }
  });

  it('documents every launched official macro series and policy agency from runtime declarations', () => {
    const english = read('docs/china-official-macro-policy.mdx');
    const chinese = read('docs/zh/china-official-macro-policy.mdx');

    assertIncludesEvery(english, CHINA_MACRO_REQUIRED_SERIES, 'English macro documentation');
    assertIncludesEvery(chinese, CHINA_MACRO_REQUIRED_SERIES, 'Chinese macro documentation');
    assertIncludesEvery(
      english,
      [...new Set(CHINA_MACRO_REQUIRED_SERIES.map(
        (seriesId) => CHINA_MACRO_SERIES_CONTRACT[seriesId].source,
      ))],
      'English macro source documentation',
    );
    assertIncludesEvery(english, CHINA_POLICY_AGENCIES, 'English policy documentation');
    assertIncludesEvery(chinese, CHINA_POLICY_AGENCIES, 'Chinese policy documentation');

    for (const source of Object.values(CHINA_POLICY_SOURCES)) {
      const host = new URL(source.listUrl).host;
      assert.ok(english.includes(host), `English policy documentation is missing ${host}`);
      assert.ok(chinese.includes(host), `Chinese policy documentation is missing ${host}`);
    }

    const requiredSeries = new Set(CHINA_MACRO_REQUIRED_SERIES);
    const unavailableSeriesIds = Object.keys(CHINA_MACRO_SERIES_CONTRACT)
      .filter((seriesId) => !requiredSeries.has(seriesId));
    for (const unavailableSeries of unavailableSeriesIds) {
      assert.ok(
        english.includes(unavailableSeries),
        `English macro documentation must disclose unavailable ${unavailableSeries}`,
      );
      assert.ok(
        chinese.includes(unavailableSeries),
        `Chinese macro documentation must disclose unavailable ${unavailableSeries}`,
      );
    }
  });

  it('documents every stable China health projection contract and launch state', () => {
    const english = read('docs/china-data-coverage.mdx');
    const chinese = read('docs/zh/china-data-coverage.mdx');

    for (const entry of CHINA_COVERAGE_ENTRIES) {
      for (const content of [english, chinese]) {
        assert.ok(content.includes(entry.id), `China inventory is missing ${entry.id}`);
        assert.ok(
          content.includes(`\`${entry.launchStatus}\``),
          `China inventory is missing the ${entry.launchStatus} launch state`,
        );
        if (entry.launchStatus === 'blocked') {
          assert.ok(
            content.includes(entry.blockedReason),
            `China inventory is missing ${entry.id} reason ${entry.blockedReason}`,
          );
        }
      }
    }
    assert.ok(
      english.includes('/api/seed-health')
        && english.includes('fresh evaluator heartbeat does not prove healthy China content'),
      'English inventory must not present evaluator freshness as content health',
    );
    assert.ok(
      chinese.includes('/api/seed-health')
        && chinese.includes('heartbeat 不证明中国内容健康'),
      'Chinese inventory must not present evaluator freshness as content health',
    );
  });

  it('documents every exchange decision, reviewed issuer, and transport fallback', () => {
    const english = read('docs/china-corporate-disclosures.mdx');
    const chinese = read('docs/zh/china-corporate-disclosures.mdx');

    for (const contract of Object.values(OFFICIAL_EXCHANGE_SOURCE_CONTRACTS)) {
      for (const value of [
        contract.exchange,
        contract.launchStatus,
        contract.admissionDecision,
        contract.termsUrl,
      ]) {
        assert.ok(english.includes(value), `English disclosure documentation is missing ${value}`);
        assert.ok(chinese.includes(value), `Chinese disclosure documentation is missing ${value}`);
      }
    }

    const securityCodes = REVIEWED_DISCLOSURE_ISSUERS.map((issuer) => issuer.securityCode);
    assertIncludesEvery(english, securityCodes, 'English reviewed-issuer documentation');
    assertIncludesEvery(chinese, securityCodes, 'Chinese reviewed-issuer documentation');
    assertIncludesEvery(
      english,
      ['SSE_PROXY_URL', 'SZSE_PROXY_URL', 'PROXY_URL', 'RELAY_SHARED_SECRET'],
      'English disclosure transport documentation',
    );
    assertIncludesEvery(
      chinese,
      [
        'SSE_PROXY_URL',
        'SZSE_PROXY_URL',
        'PROXY_URL',
        'RELAY_SHARED_SECRET',
        '不是按 URL 顺序回退',
      ],
      'Chinese disclosure transport documentation',
    );
    assert.ok(
      english.includes('not sequential URL failover'),
      'English disclosure transport documentation must distinguish precedence from failover',
    );
  });

  it('documents every configured logistics corridor, signal family, and source family', () => {
    const english = read('docs/china-logistics-corridors.mdx');
    const chinese = read('docs/zh/china-logistics-corridors.mdx');

    for (const corridor of CHINA_LOGISTICS_CORRIDORS) {
      assert.ok(english.includes(corridor.id), `English corridor documentation is missing ${corridor.id}`);
      assert.ok(chinese.includes(corridor.id), `Chinese corridor documentation is missing ${corridor.id}`);
    }
    assertIncludesEvery(english, CHINA_CORRIDOR_SIGNAL_FAMILIES, 'English corridor family documentation');
    assertIncludesEvery(chinese, CHINA_CORRIDOR_SIGNAL_FAMILIES, 'Chinese corridor family documentation');
    assertIncludesEvery(
      english,
      [
        'IMF PortWatch',
        'AviationStack',
        'Hong Kong Observatory',
        'WorldMonitor energy spine',
        'UN Comtrade',
        'Shanghai Shipping Exchange',
      ],
      'English corridor source documentation',
    );
  });

  it('documents bilateral HS4 period selection, quota, coverage, cadence, and consumer route', () => {
    const english = read('docs/china-data-coverage.mdx');
    const chinese = read('docs/zh/china-data-coverage.mdx');
    for (const content of [english, chinese]) {
      assertIncludesEvery(
        content,
        [
          '0 6 1 * *',
          'COMTRADE_API_KEYS',
          String(REQUEST_BUDGET),
          String(MIN_COUNTRY_COVERAGE),
          'get-country-products',
          'Y-2',
          'Y-3',
          'Y-5',
        ],
        'Bilateral HS4 documentation',
      );
    }
  });

  it('keeps human route maps synchronized with the China RPC surface', () => {
    for (const path of ['docs/finance-data.mdx', 'docs/zh/finance-data.mdx']) {
      const content = read(path);
      assertIncludesEvery(
        content,
        [
          '/api/economic/v1/get-china-macro-snapshot',
          '/api/economic/v1/get-china-activity-nowcast',
        ],
        path,
      );
    }
    for (const path of ['docs/panels/supply-chain.mdx', 'docs/zh/panels/supply-chain.mdx']) {
      assert.ok(
        read(path).includes('/api/supply-chain/v1/get-china-corridor-control-towers'),
        `${path} is missing the China corridor RPC`,
      );
    }
  });

  it('documents REST, UI, and MCP access boundaries without implying tool parity', () => {
    for (const path of ['docs/china-data-coverage.mdx', 'docs/zh/china-data-coverage.mdx']) {
      assertIncludesEvery(
        read(path),
        [
          'REST/UI',
          'get_china_decision_signals',
          'get_economic_data',
          'china-macro',
          'china-release-calendar',
        ],
        path,
      );
    }
    for (const path of [
      'docs/china-logistics-corridors.mdx',
      'docs/zh/china-logistics-corridors.mdx',
      'docs/methodology/china-activity-nowcast.mdx',
      'docs/zh/methodology/china-activity-nowcast.mdx',
    ]) {
      assertIncludesEvery(
        read(path),
        ['REST/UI', 'get_china_decision_signals'],
        path,
      );
    }
  });

  it('keeps the Railway runbook synchronized with China bundle membership and proxy order', () => {
    const runbook = read('docs/railway-seed-consolidation-runbook.md');
    assertIncludesEvery(
      runbook,
      [
        'China Decision Signals (15min)',
        'China Macro (36h)',
        'China Release Calendar (36h)',
        'China Policy Events (6h)',
        'China Corporate Disclosures (30min)',
        '`SSE_PROXY_URL` → `SZSE_PROXY_URL` → `PROXY_URL`',
        'selects the first non-empty setting rather than attempting each URL sequentially',
      ],
      'Railway runbook',
    );
  });
});
