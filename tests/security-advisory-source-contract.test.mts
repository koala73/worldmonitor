import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

type AdvisoryFeed = {
  name: string;
  sourceCountry: string;
  url: string;
};

const DISCLOSURE_PATTERNS_BY_COUNTRY: Record<string, RegExp[]> = {
  AU: [/\bAU\b/i, /\bAustralia\b/i, /\bDFAT\b/i, /\bSmartraveller\b/i],
  NZ: [/\bNZ\b/i, /\bNew Zealand\b/i, /\bMFAT\b/i, /\bSafeTravel\b/i],
  UK: [/\bUK\b/i, /\bFCDO\b/i],
  US: [/\bUS\b/i, /\bU\.S\.\b/i, /\bState Dept\b/i, /\bState Department\b/i],
};

function readRepoFile(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function getStringProperty(objectLiteral: string, property: string): string {
  const match = objectLiteral.match(new RegExp(`${property}:\\s*'([^']+)'`));
  assert.ok(match, `Expected ADVISORY_FEEDS entry to include ${property}: ${objectLiteral}`);
  return match[1]!;
}

function extractAdvisoryFeeds(): AdvisoryFeed[] {
  const source = readRepoFile('scripts/seed-security-advisories.mjs');
  const match = source.match(/const ADVISORY_FEEDS = \[([\s\S]*?)\];/);
  assert.ok(match, 'scripts/seed-security-advisories.mjs must keep ADVISORY_FEEDS inspectable.');

  return [...match[1]!.matchAll(/\{([^{}]+)\}/g)].map((entry) => {
    const objectLiteral = entry[1]!;
    return {
      name: getStringProperty(objectLiteral, 'name'),
      sourceCountry: getStringProperty(objectLiteral, 'sourceCountry'),
      url: getStringProperty(objectLiteral, 'url'),
    };
  });
}

function travelAdvisorySourceCountries(feeds: AdvisoryFeed[]): string[] {
  return [...new Set(feeds
    .filter((feed) => !['EU', 'INT'].includes(feed.sourceCountry))
    .filter((feed) => !/^CDC\b/i.test(feed.name))
    .map((feed) => feed.sourceCountry))]
    .sort();
}

function inactiveCountryClaimPatterns(sourceCountries: string[]): RegExp[] {
  return Object.entries(DISCLOSURE_PATTERNS_BY_COUNTRY)
    .filter(([country]) => !sourceCountries.includes(country))
    .flatMap(([, patterns]) => patterns);
}

function assertDoesNotClaimInactiveSources(label: string, text: string, sourceCountries: string[]): void {
  const violations = inactiveCountryClaimPatterns(sourceCountries)
    .filter((pattern) => pattern.test(text))
    .map((pattern) => String(pattern));

  assert.deepEqual(violations, [], `${label} claims advisory sources absent from ADVISORY_FEEDS.`);
}

describe('security advisory source contract', () => {
  it('panel country filters are derived from active travel-advisory feed countries', () => {
    const expectedCountries = travelAdvisorySourceCountries(extractAdvisoryFeeds());
    const panel = readRepoFile('src/components/SecurityAdvisoriesPanel.ts');

    const typeMatch = panel.match(/type AdvisoryFilter = ([^;]+);/);
    assert.ok(typeMatch, 'SecurityAdvisoriesPanel must keep AdvisoryFilter inspectable.');
    const typedFilters = [...typeMatch[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    const typedCountryFilters = typedFilters.filter((filter) => /^[A-Z]{2}$/.test(filter!)).sort();

    const renderedCountryFilters = [...panel.matchAll(/data-filter="([A-Z]{2})"/g)]
      .map((match) => match[1]!)
      .sort();

    assert.deepEqual(typedCountryFilters, expectedCountries);
    assert.deepEqual(renderedCountryFilters, expectedCountries);
  });

  it('public advisory docs disclose only active travel-advisory feed countries', () => {
    const feeds = extractAdvisoryFeeds();
    const sourceCountries = travelAdvisorySourceCountries(feeds);
    const docs = [
      ['docs/data-sources.mdx', readRepoFile('docs/data-sources.mdx')],
      ['docs/PRESS_KIT.md', readRepoFile('docs/PRESS_KIT.md')],
    ] as const;

    for (const [path, text] of docs) {
      assertDoesNotClaimInactiveSources(path, text, sourceCountries);
    }

    const dataSources = docs[0][1];
    assert.match(
      dataSources,
      new RegExp(`fetches all ${feeds.length} feeds hourly`),
      'docs/data-sources.mdx feed count must match ADVISORY_FEEDS.',
    );

    for (const country of sourceCountries) {
      const patterns = DISCLOSURE_PATTERNS_BY_COUNTRY[country] ?? [];
      assert.ok(
        patterns.some((pattern) => pattern.test(dataSources)),
        `docs/data-sources.mdx must disclose active advisory source country ${country}.`,
      );
    }
  });

  it('localized panel source copy does not advertise inactive feed countries', () => {
    const sourceCountries = travelAdvisorySourceCountries(extractAdvisoryFeeds());
    const localeDir = resolve(root, 'src/locales');

    for (const file of readdirSync(localeDir).filter((name) => name.endsWith('.json'))) {
      const locale = JSON.parse(readFileSync(resolve(localeDir, file), 'utf8'));
      const securityAdvisories = locale?.components?.securityAdvisories;
      assert.ok(securityAdvisories, `${file} must define components.securityAdvisories.`);

      assertDoesNotClaimInactiveSources(
        `${file} components.securityAdvisories.sources`,
        String(securityAdvisories.sources ?? ''),
        sourceCountries,
      );
      assertDoesNotClaimInactiveSources(
        `${file} components.securityAdvisories.infoTooltip`,
        String(securityAdvisories.infoTooltip ?? ''),
        sourceCountries,
      );
    }
  });
});
