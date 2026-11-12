import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { requireCountryCode, resolveCountryArg, resolveCountryFilter } from '../api/mcp/_country-args.ts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { normalizeLocalizedCountryToken } from '../shared/country-code-resolve-localized.ts';
import DATA from '../shared/country-names-localized.json' with { type: 'json' };
import { assignedCountryCodes } from '../scripts/build-country-names-ar.mjs';
import { buildLocalizedCountryNames, supportedCountryLocales } from '../scripts/build-country-names-localized.mjs';
import { resolveCountryCode } from '../shared/country-code-resolve.ts';
import ISO3_TO_ISO2 from '../shared/iso3-to-iso2.json' with { type: 'json' };

const locales = DATA.locales as Record<string, Record<string, string[]>>;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

for (const [locale, names] of Object.entries(locales)) {
  describe(`MCP country arguments in ${locale}`, () => {
    it('covers all assigned codes', () => {
      assert.deepEqual(Object.keys(names), assignedCountryCodes());
    });
    it('resolves every committed long and short name to its country', () => {
      for (const [code, aliases] of Object.entries(names)) {
        assert.ok(aliases.length, `${locale} ${code} has no names`);
        for (const name of aliases) assert.equal(resolveCountryArg(name), code, `${locale} ${code} ${name}`);
      }
    });
    it('resolves a localized country at the required and optional boundaries', () => {
      const germany = names.DE![0]!;
      assert.equal(requireCountryCode(germany, 'get-country-risk'), 'DE');
      assert.deepEqual(resolveCountryFilter([germany, names.JP![0]!], 'countries'), ['de', 'jp']);
    });
    it('rejects a contradictory country code', () => {
      assert.equal(resolveCountryArg(`${names.DE![0]} (FR)`), null);
      assert.equal(resolveCountryArg(`FR (${names.DE![0]})`), null);
      assert.equal(resolveCountryArg(`${names.DE![0]} (DE)`), 'DE');
    });
    it('open_country_brief validates the localized name', () => {
      const tool = TOOL_REGISTRY.find((entry) => entry.name === 'open_country_brief')!;
      assert.deepEqual(tool._validateArgs!({ country_code: names.DE![0] }), { countryCode: 'DE', topic: 'overview' });
    });
    it('summary and translation requests preserve the locale', async () => {
      const tool = TOOL_REGISTRY.find((entry) => entry.name === 'analyze_news_headlines')!;
      let sent: Record<string, unknown> = {};
      globalThis.fetch = async (_input: unknown, init?: { body?: unknown }) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({ summary: 'fixture', status: 'success' });
      };
      await tool._execute!({ headlines: ['Talks resume'], lang: locale }, 'https://www.worldmonitor.app', { kind: 'env_key', apiKey: 'fixture' }, undefined);
      assert.equal(sent.lang, locale);
      await tool._execute!({ headlines: ['Talks resume'], mode: 'translate', lang: locale }, 'https://www.worldmonitor.app', { kind: 'env_key', apiKey: 'fixture' }, undefined);
      assert.equal(sent.variant, locale);
    });
  });
}

it('commits exactly the dashboard locales and both mirrors', () => {
  assert.deepEqual(Object.keys(locales), supportedCountryLocales());
  assert.equal(readFileSync(new URL('../shared/country-names-localized.json', import.meta.url), 'utf8'),
    readFileSync(new URL('../scripts/shared/country-names-localized.json', import.meta.url), 'utf8'));
});

it('matches the CLDR generator', (t) => {
  if (process.versions.cldr !== DATA.cldr) return t.skip('Runtime CLDR differs from committed CLDR');
  assert.deepEqual(buildLocalizedCountryNames(), DATA);
});

it('preserves every ISO code and the existing short aliases over localized abbreviations', () => {
  for (let first = 65; first <= 90; first++) {
    for (let second = 65; second <= 90; second++) {
      const code = String.fromCharCode(first, second);
      assert.equal(resolveCountryArg(code), resolveCountryCode(code), code);
      assert.equal(resolveCountryArg(code.toLowerCase()), resolveCountryCode(code), code);
    }
  }
  for (const code of [...Object.keys(ISO3_TO_ISO2), 'UK', 'DRC', 'UAE']) {
    assert.equal(resolveCountryArg(code), resolveCountryCode(code), code);
  }
  assert.equal(resolveCountryArg('RU'), 'RU');
  assert.equal(resolveCountryArg('Reino Unido'), 'GB');
  assert.equal(resolveCountryArg('Nga'), 'NG');
  assert.equal(resolveCountryArg('Liên bang Nga'), 'RU');
});

it('keeps Indic and Thai vowel marks and Traditional Chinese names', () => {
  for (const [name, expected] of [['भारत', 'IN'], ['नेपाल', 'NP'], ['ไทย', 'TH'], ['德國', 'DE'], ['烏克蘭', 'UA'], ['ایران', 'IR']]) {
    assert.equal(resolveCountryArg(name), expected, name);
  }
});

it('has no cross-locale ambiguous keys in the committed data', () => {
  const owners = new Map<string, string>();
  for (const names of Object.values(locales)) {
    for (const [code, aliases] of Object.entries(names)) {
      for (const name of aliases) {
        const key = normalizeLocalizedCountryToken(name);
        const previous = owners.get(key);
        assert.ok(!previous || previous === code, `${name} collides for ${previous} and ${code}`);
        owners.set(key, code);
      }
    }
  }
});

it('accepts case, accents, compatibility forms and localized modifiers', () => {
  for (const [name, code] of [['DEUTSCHLAND', 'DE'], ['Ｔｈａｉｌａｎｄ', 'TH'], ['TÜRKİYE', 'TR'], ['Việt Nam', 'VN'], ['Soudan (du Sud)', 'SS'], ['غينيا (الاستوائية)', 'GQ']]) {
    assert.equal(resolveCountryArg(name), code, name);
  }
});

it('rejects unknown words, multi-country input and prototype names', () => {
  for (const input of [null, {}, '__proto__', 'constructor', 'Deutschland France', '未知 (DE)', 'Deutschland (未知)', 'भारत'.repeat(40)]) {
    assert.equal(resolveCountryArg(input), null, JSON.stringify(input));
  }
});
