import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MEDIA_PERSPECTIVE_TOOL as tool } from '../api/mcp/registry/media-perspective-tool.ts';

function rejects(params, field) {
  assert.throws(() => tool._validateArgs(params), (error) => error.violations?.some((violation) => violation.field === field));
}

function group(homeCountry, count) {
  return {
    homeCountry,
    audience: 'domestic',
    outletCount: 1,
    headlineCount: count,
    headlines: Array.from({ length: count }, (_, i) => ({ title: `${homeCountry} ${i}` })),
  };
}

describe('get_media_perspective', () => {
  it('requires a resolvable subject country and accepts a name', () => {
    rejects({}, 'subject_country');
    rejects({ subject_country: 'Atlantis' }, 'subject_country');
    assert.equal(tool._validateArgs({ subject_country: 'Saudi Arabia' }).subject, 'SA');
  });

  it('rejects an unknown audience or an unsupported window', () => {
    rejects({ subject_country: 'SA', audience: 'elite' }, 'audience');
    rejects({ subject_country: 'SA', window_hours: 50 }, 'window_hours');
    rejects({ subject_country: 'SA', outlet_regions: ['latam'] }, 'outlet_regions');
    rejects({ subject_country: 'SA', outlet_regions: 'europe' }, 'outlet_regions');
    assert.deepEqual(tool._validateArgs({ subject_country: 'SA', outlet_countries: ['Iran', 'EG'], audience: 'domestic', window_hours: 24 }),
      { subject: 'SA', outletCountries: ['IR', 'EG'], outletRegions: [], audience: 'domestic', windowHours: 24 });
  });

  it('forwards canonical arguments to the API route', async () => {
    let requested = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      requested = String(url);
      return Response.json({ subjectCountry: 'SA', windowHours: 24, groups: [], noCoverageCountries: [], unattributedCount: 0, state: 'complete' });
    };
    try {
      await tool._execute({ subject_country: 'SA', outlet_countries: ['IR', 'EG'], outlet_regions: ['western-asia', 'northern-africa'], audience: 'domestic', window_hours: 24 }, 'https://api.example.test', { kind: 'env_key', apiKey: 'wm_fixture' });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const url = new URL(requested);
    assert.equal(url.pathname, '/api/news/v1/list-media-perspective');
    assert.equal(url.searchParams.get('subject_country'), 'SA');
    assert.deepEqual(url.searchParams.getAll('outlet_countries'), ['IR', 'EG']);
    assert.deepEqual(url.searchParams.getAll('outlet_regions'), ['western-asia', 'northern-africa']);
    assert.equal(url.searchParams.get('audience'), 'domestic');
    assert.equal(url.searchParams.get('window_hours'), '24');
  });

  it('trims headlines inside groups for the output budget and never drops a group', () => {
    const fitted = tool._fitToBudget({ groups: [group('SA', 20), group('EG', 2)] }, tool._outputBudgetBytes, {});
    assert.deepEqual(fitted.groups.map((entry) => [entry.homeCountry, entry.headlines.length, entry.headlineCount]),
      [['SA', 3, 20], ['EG', 2, 2]]);
  });

  it('keeps every group of a broad region query inside the budget by shedding samples further', () => {
    const wide = (homeCountry, count) => ({
      ...group(homeCountry, count),
      headlines: Array.from({ length: count }, (_, i) => ({ title: `${homeCountry} ${i} ${'x'.repeat(400)}`, link: `https://example.org/${homeCountry}/${i}` })),
    });
    const codes = Array.from({ length: 300 }, (_, i) => `C${i}`);
    const fitted = tool._fitToBudget({ groups: codes.map((code) => wide(code, 20)) }, tool._outputBudgetBytes, {});
    assert.equal(fitted.groups.length, 300, 'no group is dropped');
    assert.ok(JSON.stringify(fitted).length <= tool._outputBudgetBytes);
    assert.ok(fitted.groups.every((entry) => entry.headlineCount === 20 && entry.headlines.length <= 1));
  });

  it('tells agents that framing is a model reading and translations are untrusted', () => {
    assert.match(tool.description, /model's reading of headline stance, not WorldMonitor's view/);
    assert.match(tool.description, /untrusted/);
  });
});
