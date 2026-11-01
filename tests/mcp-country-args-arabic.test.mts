// Arabic country names in MCP tool arguments (#9722, "Voice and agent consumers").
//
// An agent serving Arabic-speaking users passes the country the user named,
// in Arabic: "السعودية", "الإمارات", "مصر". Every MCP country argument resolves
// through requireCountryCode / resolveCountryFilter (api/mcp/_country-args.ts)
// or resolveCountryArg directly, so these cases pin that one boundary: CLDR
// Arabic names and common short and official forms resolve for every country
// the English resolver supports, spelling variants normalize, ambiguous or
// conflicting inputs stay unresolved, and the error for an unknown name still
// names the value.

import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  COUNTRY_ARG_HINT,
  requireCountryCode,
  resolveCountryArg,
  resolveCountryFilter,
} from '../api/mcp/_country-args.ts';
import { isAssignedCountryCode, resolveCountryCode } from '../shared/country-code-resolve.ts';
import { normalizeArabicCountryToken, resolveArabicCountryName } from '../shared/country-code-resolve-arabic.ts';
import ARABIC_NAMES from '../shared/country-names-ar.json' with { type: 'json' };
import LOCALIZED_NAMES from '../shared/country-names-localized.json' with { type: 'json' };
import { buildArabicCountryNames } from '../scripts/build-country-names-ar.mjs';
import { mcpHandler } from '../api/mcp.ts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { normalizeCountryDirectRead } from '../shared/country-brief-host.ts';
import { buildArticlePrompts } from '../server/worldmonitor/news/v1/_shared.ts';
import { HMAC_SECRET, callBody, makePipelineMock } from './helpers/mcp-pro-deps.mjs';

const AR = new Intl.DisplayNames(['ar'], { type: 'region' });

function allAssignedCodes(): string[] {
  const codes: string[] = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (isAssignedCountryCode(code)) codes.push(code);
    }
  }
  return codes;
}

describe('Arabic country names resolve at the MCP argument boundary', () => {
  const cases: Array<[string, string]> = [
    ['السعودية', 'SA'],
    ['المملكة العربية السعودية', 'SA'],
    ['الإمارات', 'AE'],
    ['الإمارات العربية المتحدة', 'AE'],
    ['دولة الإمارات العربية المتحدة', 'AE'],
    ['مصر', 'EG'],
    ['جمهورية مصر العربية', 'EG'],
    ['إيران', 'IR'],
    ['العراق', 'IQ'],
    ['اليمن', 'YE'],
    ['قطر', 'QA'],
    ['الكويت', 'KW'],
    ['البحرين', 'BH'],
    ['عُمان', 'OM'],
    ['سلطنة عمان', 'OM'],
    ['الأردن', 'JO'],
    ['لبنان', 'LB'],
    ['سوريا', 'SY'],
    ['سورية', 'SY'],
    ['فلسطين', 'PS'],
    ['الولايات المتحدة الأمريكية', 'US'],
    ['أمريكا', 'US'],
    ['بريطانيا', 'GB'],
    ['روسيا', 'RU'],
    ['الصين', 'CN'],
    ['تركيا', 'TR'],
    ['السودان', 'SD'],
    ['جنوب السودان', 'SS'],
    ['كوريا الشمالية', 'KP'],
    ['كوريا الجنوبية', 'KR'],
    ['الكونغو الديمقراطية', 'CD'],
    ['ميانمار', 'MM'],
    ['بورما', 'MM'],
  ];
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      assert.equal(requireCountryCode(input, 'test'), expected);
    });
  }

  it('optional country filters accept Arabic names, singly and in arrays', () => {
    assert.deepEqual(resolveCountryFilter('السعودية', 'country'), ['sa']);
    assert.deepEqual(resolveCountryFilter(['الإمارات', 'قطر', 'IQ', 'Iran'], 'countries'), ['ae', 'qa', 'iq', 'ir']);
  });

  it('resolveCountryArg keeps every English, alpha-2 and alpha-3 answer', () => {
    for (const input of ['Iraq', 'IQ', 'IRQ', 'UK', 'Congo (DRC)', 'Myanmar (Burma)', 'ZZ']) {
      assert.equal(resolveCountryArg(input), resolveCountryCode(input), input);
    }
  });
});

describe('Arabic spelling variants normalize', () => {
  const variants: Array<[string, string, string]> = [
    ['without the article', 'سعودية', 'SA'],
    ['without the article', 'عراق', 'IQ'],
    ['bare alef for hamza', 'ايران', 'IR'],
    ['bare alef for hamza', 'الامارات', 'AE'],
    ['bare alef for hamza-below', 'اسرائيل', 'IL'],
    ['haa for taa marbuta', 'السعوديه', 'SA'],
    ['alef maqsura for yaa', 'الولايات المتحده الامريكيه', 'US'],
    ['tatweel', 'الســعودية', 'SA'],
    ['full diacritics', 'العِرَاق', 'IQ'],
    ['Persian yeh and kaf', 'الکویت', 'KW'],
    ['surrounding whitespace', '  مصر  ', 'EG'],
    ['dash or parentheses in a CLDR name', 'الكونغو (كينشاسا)', 'CD'],
    ['Arabic presentation forms', 'ﻣﺼﺮ', 'EG'],
    // A parenthetical modifier is part of the name, not noise to discard:
    // dropping it answered "Sudan (South)" with Sudan.
    ['split name, modifier first', 'السودان (جنوب)', 'SS'],
    ['split name, modifier last', 'غينيا (الاستوائية)', 'GQ'],
    ['split name, Arabic base and code', 'العراق (IQ)', 'IQ'],
    ['split name, English base', 'Iraq (العراق)', 'IQ'],
  ];
  for (const [label, input, expected] of variants) {
    it(`${label}: ${input} -> ${expected}`, () => {
      assert.equal(resolveCountryArg(input), expected);
    });
  }

  it('folds every variant onto one token', () => {
    const forms = ['الإمارات', 'الامارات', 'الإمَارَات', 'الإمـارات', 'إمارات'];
    const keys = new Set(forms.map(normalizeArabicCountryToken));
    assert.equal(keys.size, 1, JSON.stringify([...keys]));
  });
});

describe('Arabic inputs that must not resolve', () => {
  const rejects: Array<[string, string]> = [
    ['two countries named together', 'السعودية (إيران)'],
    ['two countries side by side', 'السعودية إيران'],
    ['a code that contradicts the Arabic name', 'السعودية (IR)'],
    ['an unresolved modifier on a country', 'السودان (مرحبا)'],
    ['an unresolved Arabic base on a code', 'مرحبا (IR)'],
    ['a bare ambiguous name', 'كوريا'],
    ['a city, not a country', 'الرياض'],
    ['a demonym', 'السعودي'],
    ['an unrelated word', 'مرحبا'],
    ['a lone article', 'ال'],
    ['punctuation only', '،؛'],
    ['an overlong value', 'مصر'.repeat(60)],
  ];
  for (const [label, input] of rejects) {
    it(`${label}: ${input.slice(0, 24)}`, () => {
      assert.equal(resolveCountryArg(input), null);
      assert.equal(resolveArabicCountryName(input), null);
    });
  }

  it('Arabic text never reaches the alpha-2 or alpha-3 passthrough', () => {
    assert.equal(resolveArabicCountryName('IQ'), null);
    assert.equal(resolveArabicCountryName('Iraq'), null);
  });

  it('still raises a validation error that names the unresolved value', () => {
    assert.throws(() => requireCountryCode('مرحبا', 'get-country-risk'), (error: Error) => {
      const violations = (error as unknown as { violations: Array<{ field: string; description: string }> }).violations;
      assert.equal(error.name, 'RpcValidationError');
      assert.equal(violations[0]?.field, 'country_code');
      assert.ok(violations[0]?.description.includes('"مرحبا"'), violations[0]?.description);
      assert.ok(violations[0]?.description.includes(COUNTRY_ARG_HINT));
      return true;
    });
  });

  it('the argument hint tells agents Arabic names are accepted', () => {
    assert.match(COUNTRY_ARG_HINT, /Arabic/);
  });
});

describe('Arabic name data', () => {
  const names = ARABIC_NAMES.names as Record<string, string[]>;

  it('covers every assigned country code, and only those', () => {
    assert.deepEqual(Object.keys(names).sort(), allAssignedCodes());
  });

  it('resolves the CLDR Arabic name of every assigned country to that country', () => {
    for (const code of allAssignedCodes()) {
      const cldr = AR.of(code);
      if (!cldr || cldr === code) continue;
      assert.equal(resolveCountryArg(cldr), code, `${code} ${cldr}`);
    }
  });

  it('resolves every committed name to its own country', () => {
    for (const [code, list] of Object.entries(names)) {
      for (const name of list) assert.equal(resolveArabicCountryName(name), code, `${code} ${name}`);
    }
  });

  it('no two countries share a normalized name', () => {
    const owner = new Map<string, string>();
    for (const [code, list] of Object.entries(names)) {
      for (const name of list) {
        const key = normalizeArabicCountryToken(name);
        assert.ok(key, `${code} ${name} normalizes to nothing`);
        const prior = owner.get(key);
        assert.ok(!prior || prior === code, `${name}: ${prior} and ${code} collide on "${key}"`);
        owner.set(key, code);
      }
    }
  });

  it('matches the generator output (node scripts/build-country-names-ar.mjs)', (t) => {
    // CLDR names come from the running ICU. A different CLDR release may
    // rename a country; the committed file records which release built it.
    if (process.versions.cldr !== ARABIC_NAMES.cldr) {
      t.skip(`runtime CLDR ${process.versions.cldr} differs from committed ${ARABIC_NAMES.cldr}`);
      return;
    }
    assert.deepEqual(buildArabicCountryNames(), ARABIC_NAMES);
  });
});

describe('MCP tools accept Arabic country arguments end to end', () => {
  const ENV_KEY = 'operator_test_key_country_args_arabic';
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const originalLog = console.log;
  const originalWarn = console.warn;

  function makeDeps() {
    const pipe = makePipelineMock();
    return {
      resolveBearerToContext: async () => null,
      validateProMcpToken: async () => null,
      getEntitlements: async () => ({
        planKey: 'pro',
        features: { tier: 1, mcpAccess: true, apiAccess: true },
        validUntil: Date.now() + 86_400_000,
      }),
      validateUserApiKey: async () => null,
      guardUserApiKeyValidation: async () => null,
      redisPipeline: pipe.pipeline,
    };
  }

  async function callTool(tool: string, params: Record<string, unknown>) {
    const request = new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': ENV_KEY },
      body: JSON.stringify(callBody(tool, params, 1)),
    });
    const response = await mcpHandler(request, makeDeps());
    assert.equal(response.status, 200, 'transport status');
    return response.json();
  }

  beforeEach(() => {
    process.env.WORLDMONITOR_VALID_KEYS = ENV_KEY;
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    delete process.env.MCP_TELEMETRY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    console.log = () => {};
    console.warn = () => {};
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  it('get_country_risk sends SA downstream for "المملكة العربية السعودية"', async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input: unknown) => {
      urls.push(String(input));
      return Response.json({
        countryCode: 'SA', countryName: 'Saudi Arabia', advisoryLevel: 'reconsider',
        sanctionsActive: false, sanctionsCount: 0, fetchedAt: 0, upstreamUnavailable: false,
      });
    };
    const body = await callTool('get_country_risk', { country_code: 'المملكة العربية السعودية' }) as { error?: unknown };
    assert.equal(body.error, undefined, JSON.stringify(body));
    const risk = urls.find((u) => u.includes('/api/intelligence/v1/get-country-risk'));
    assert.ok(risk, `no downstream call: ${JSON.stringify(urls)}`);
    assert.match(risk, /country_code=SA(?:&|$)/);
  });

  for (const [locale, names] of Object.entries(LOCALIZED_NAMES.locales)) {
    it(`get_country_risk sends DE downstream for a ${locale} country name`, async () => {
      const urls: string[] = [];
      globalThis.fetch = async (input: unknown) => {
        urls.push(String(input));
        return Response.json({ countryCode: 'DE', countryName: 'Germany', fetchedAt: 0 });
      };
      const body = await callTool('get_country_risk', { country_code: names.DE[0] }) as { error?: unknown };
      assert.equal(body.error, undefined, JSON.stringify(body));
      const risk = urls.find((url) => url.includes('/api/intelligence/v1/get-country-risk'));
      assert.ok(risk, `no downstream call for ${locale}`);
      assert.match(risk, /country_code=DE(?:&|$)/);
    });
  }

  it('get_country_risk returns Invalid params naming an unknown Arabic value', async () => {
    globalThis.fetch = async () => { throw new Error('must not fetch'); };
    const body = await callTool('get_country_risk', { country_code: 'مرحبا' }) as { error?: { code: number; message: string; data?: unknown } };
    assert.equal(body.error?.code, -32602, JSON.stringify(body));
    assert.ok(JSON.stringify(body.error).includes('مرحبا'), JSON.stringify(body.error));
  });
});

describe('tools that resolve the country themselves accept Arabic names', () => {
  const originalFetch = globalThis.fetch;
  const CTX = { kind: 'env_key', apiKey: 'fixture-key' } as const;
  const BASE = 'https://www.worldmonitor.app';
  const tool = (name: string) => {
    const found = TOOL_REGISTRY.find((t) => t.name === name);
    assert.ok(found, `missing tool ${name}`);
    return found;
  };

  afterEach(() => { globalThis.fetch = originalFetch; });

  it('open_country_brief', () => {
    assert.deepEqual(tool('open_country_brief')._validateArgs!({ country_code: 'السعودية' }), { countryCode: 'SA', topic: 'overview' });
  });

  it('get_no2_activity', async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input: unknown) => { urls.push(String(input)); return Response.json({ regions: [] }); };
    tool('get_no2_activity')._validateArgs!({ country_code: 'الصين' });
    await tool('get_no2_activity')._execute!({ country_code: 'الصين' }, BASE, CTX, {});
    assert.match(urls.at(-1) ?? '', /country_code=CN(?:&|$)/);
  });

  it('get_tariff_averages and get_bilateral_tariff', () => {
    tool('get_tariff_averages')._validateArgs!({ reporter: 'السعودية', partner: 'الصين' });
    tool('get_bilateral_tariff')._validateArgs!({ reporter: 'الإمارات', partner: 'الهند', hs_code: '870380' });
    assert.throws(() => tool('get_tariff_averages')._validateArgs!({ reporter: 'مرحبا' }), { name: 'RpcValidationError' });
  });

  for (const name of ['get_airspace', 'get_maritime_activity']) {
    it(name, async () => {
      globalThis.fetch = async () => Response.json({});
      const result = await tool(name)._execute!({ country_code: 'العراق' }, BASE, CTX, {}) as { error?: string };
      assert.ok(!String(result?.error ?? '').startsWith('Could not resolve'), String(result?.error));
      const unknown = await tool(name)._execute!({ country_code: 'مرحبا' }, BASE, CTX, {}) as { error?: string };
      assert.match(String(unknown.error), /^Could not resolve "مرحبا"/);
    });
  }

  it('paid country panels normalize Arabic direct reads', () => {
    assert.deepEqual(normalizeCountryDirectRead('get_country_brief', { country_code: 'مصر' }, resolveCountryArg), { country_code: 'EG' });
    assert.deepEqual(normalizeCountryDirectRead('get_country_risk', { country_code: 'قطر', history_days: 7 }, resolveCountryArg), { country_code: 'QA', history_days: 7 });
  });
});

// Arabic summaries use the existing summarize-article output-language path.
describe('analyze_news_headlines returns Arabic summaries on request', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  for (const lang of ['ar', 'ar-SA', 'AR_ae']) {
    it(`brief mode sends lang "ar" for ${lang}`, async () => {
      const tool = TOOL_REGISTRY.find((t) => t.name === 'analyze_news_headlines')!;
      let sent: Record<string, unknown> = {};
      globalThis.fetch = async (_input: unknown, init?: { body?: unknown }) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({ summary: 'ملخص', status: 'success' });
      };
      await tool._execute!({ headlines: ['Gulf talks resume', 'Oil prices rise'], lang }, 'https://www.worldmonitor.app', { kind: 'env_key', apiKey: 'fixture-key' }, undefined);
      assert.equal(sent.mode, 'brief');
      assert.equal(sent.lang, 'ar');
    });
  }

  it('the brief prompt instructs Arabic output', () => {
    const { systemPrompt } = buildArticlePrompts(['A'], ['A'], { mode: 'brief', geoContext: '', variant: 'full', lang: 'ar' });
    assert.match(systemPrompt, /Output the summary in AR language\./);
  });
});
