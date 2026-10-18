// Served-shape coverage for get_country_brief grounding corroboration
// (#4925 item 3).
//
// The digest carries corroborationCount and storyMeta on every item
// (server/worldmonitor/news/v1/list-feed-digest.ts toProtoItem), and the tool
// threw both away. Corroboration cannot ride on `sources`: that array is the
// proto BriefSource shape returned by the gateway, so it lands on a sibling
// `groundingStories` field instead. These cases pin that decision.

import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { __testing__, mcpHandler } from '../api/mcp.ts';
import { HMAC_SECRET, callBody, makePipelineMock } from './helpers/mcp-pro-deps.mjs';
import { getSourceProvenanceState, SOURCE_PROPAGANDA_RISK } from '../shared/source-provenance.ts';

const ENV_KEY = 'operator_test_key_country_brief_grounding';
const MCP_URL = 'https://worldmonitor.app/mcp';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalLog = console.log;
const originalWarn = console.warn;

function compactProvenance(source) {
  const { summary, ...provenance } = getSourceProvenanceState(source);
  return provenance;
}

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

/** A digest item as toProtoItem actually emits it. */
function digestItem(overrides = {}) {
  return {
    title: 'France announces new energy package',
    source: 'Example Wire',
    link: 'https://example.com/fr-energy',
    publishedAt: 1_786_320_000_000,
    corroborationCount: 4,
    storyMeta: {
      firstSeen: 1_754_000_000_000,
      mentionCount: 3,
      sourceCount: 4,
      phase: 'STORY_PHASE_DEVELOPING',
    },
    ...overrides,
  };
}

/** The gateway's own source list, which wins over the MCP-local grounding set
 *  on the common path — this is why groundingStories cannot derive from it. */
const UPSTREAM_SOURCES = [{
  title: 'Upstream server-side grounding article',
  source: 'Server Wire',
  link: 'https://example.com/upstream',
  publishedAt: '2026-08-10T01:00:00.000Z',
}];

function stubDownstream({
  digestItems,
  digestOk = true,
  digestCoverage,
  briefSources = UPSTREAM_SOURCES,
  briefExtras = {},
}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const { pathname } = new URL(String(input));
    calls.push({ pathname, init });
    if (pathname === '/api/news/v1/list-feed-digest') {
      if (!digestOk) throw new Error('digest unavailable');
      return new Response(JSON.stringify({
        categories: { world: { items: digestItems } },
        ...(digestCoverage ? { coverage: digestCoverage } : {}),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (pathname === '/api/intelligence/v1/get-country-intel-brief') {
      return new Response(JSON.stringify({
        country_code: 'FR',
        brief: 'Synthesized country brief.',
        framework: '',
        generatedAt: '2026-08-10T02:00:00.000Z',
        provider: 'seeded-provider',
        model: 'seeded-model',
        sources: briefSources,
        ...briefExtras,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected downstream URL: ${String(input)}`);
  };
  return calls;
}

async function callCountryBriefRpc(params = { country_code: 'FR' }, id = 1) {
  const request = new Request(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': ENV_KEY },
    body: JSON.stringify(callBody('get_country_brief', params, id)),
  });
  const response = await mcpHandler(request, makeDeps());
  assert.equal(response.status, 200, 'transport status');
  return response.json();
}

async function callCountryBriefResult(params = { country_code: 'FR' }, id = 1) {
  const rpc = await callCountryBriefRpc(params, id);
  assert.ok(rpc.result?.content?.[0]?.text, `no tool result: ${JSON.stringify(rpc).slice(0, 400)}`);
  const rawText = rpc.result.content[0].text;
  return { payload: JSON.parse(rawText), rawText };
}

async function callCountryBrief(params = { country_code: 'FR' }, id = 1) {
  const { payload } = await callCountryBriefResult(params, id);
  return payload;
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

describe('get_country_brief grounding corroboration (#4925 item 3)', () => {
  it('attaches registry provenance to gateway citations and digest grounding', async () => {
    stubDownstream({
      digestItems: [digestItem({ source: 'RT' }), digestItem({ title: 'France other story', source: 'Unknown outlet' })],
      briefSources: [{ ...UPSTREAM_SOURCES[0], source: 'EuroNews' }],
    });
    const payload = await callCountryBrief();
    assert.deepEqual(payload.sources[0].sourceProvenance, compactProvenance('EuroNews'));
    assert.deepEqual(payload.sources[0].sourceProvenance.knownBiases, ['Pro-EU']);
    assert.deepEqual(payload.groundingStories[0].sourceProvenance, compactProvenance('RT'));
    assert.ok(payload.groundingStories[0].sourceProvenance.stateAffiliated);
    assert.deepEqual(payload.groundingStories[1].sourceProvenance.knownBiases, []);
    assert.equal(payload.groundingStories[1].sourceProvenance.stateAffiliated, undefined);
  });

  it('attaches provenance to fallback citations and declares both response contracts', async () => {
    stubDownstream({ digestItems: [digestItem({ source: 'RT' })], briefSources: [] });
    const payload = await callCountryBrief();
    assert.deepEqual(payload.sources[0].sourceProvenance, compactProvenance('RT'));
    const tool = __testing__.TOOL_REGISTRY.find(candidate => candidate.name === 'get_country_brief');
    for (const field of ['sources', 'groundingStories']) {
      const schema = tool.outputSchema.properties[field].items;
      assert.ok(schema.required.includes('sourceProvenance'));
      assert.ok(schema.properties.sourceProvenance.required.includes('knownBiases'));
      assert.ok(schema.properties.sourceProvenance.properties.stateAffiliated);
    }
    assert.ok(tool.outputSchema.properties.groundingStories.items.properties.publishers);
  });

  it('retains sibling publishers beyond the context cap and folds publisher families', async () => {
    const first = digestItem({ source: 'Reuters', corroborationCount: 4 });
    const filler = Array.from({ length: 15 }, (_, i) => digestItem({ title: `France unrelated item ${i}` }));
    stubDownstream({ digestItems: [first, ...filler,
      { ...first, source: 'Reuters World' }, { ...first, source: 'BBC World' },
    ] });
    const payload = await callCountryBrief();
    const story = payload.groundingStories[0];
    assert.equal(story.publishers.length, 2);
    assert.ok(story.publishers.some(p => p.labels.includes('Reuters') && p.labels.includes('Reuters World')));
    assert.ok(story.publishers.some(p => p.labels.includes('BBC World') && p.tier === 2));
    assert.equal(story.publishersUnlisted, 2);
    assert.equal(story.publishers.length + story.publishersUnlisted, story.corroboration.publishers);
  });

  it('ignores a malformed sibling source without losing valid grounding', async () => {
    stubDownstream({ digestItems: [digestItem({ source: 'Reuters' }), digestItem({ source: 123 })] });
    const payload = await callCountryBrief();
    assert.equal(payload.groundingStories.length, 1);
    assert.equal(payload.groundingStories[0].publishers[0].name, 'Reuters');
  });

  it('declares the stale opt-in and machine-readable digest coverage contract', () => {
    const tool = __testing__.TOOL_REGISTRY.find(candidate => candidate.name === 'get_country_brief');
    assert.ok(tool);
    assert.equal(tool.inputSchema.properties.allow_stale.type, 'boolean');
    const coverage = tool.outputSchema.properties.digestCoverage.properties;
    for (const field of ['state', 'servedStale', 'staleAgeSeconds', 'staleReason', 'attemptedAt']) {
      assert.ok(coverage[field], `digestCoverage must declare ${field}`);
    }
  });

  it('passes cited evidence through, and declares it', async () => {
    const evidence = [{
      id: 'E1', kind: 'resilience', label: 'Fiscal space', value: '41 of 100',
      factText: "France's fiscal space scores 41 of 100.", asOf: '2026-09-21T00:00:00.000Z', url: '',
    }];
    stubDownstream({ digestItems: [digestItem()], briefExtras: { evidence } });

    const payload = await callCountryBrief();

    assert.deepEqual(payload.evidence, evidence);
    const tool = __testing__.TOOL_REGISTRY.find(candidate => candidate.name === 'get_country_brief');
    assert.equal(tool.outputSchema.properties.evidence?.type, 'array');
    for (const field of ['id', 'label', 'value', 'asOf', 'url']) {
      assert.ok(tool.outputSchema.properties.evidence.items.properties[field], `evidence must declare ${field}`);
    }
  });

  it('DROPS stale digest grounding by default, and still returns a brief', async () => {
    // #7084: this used to throw -32003. That made the MILDER degradation fatal
    // while the worse one was tolerated -- a digest fetch that times out is
    // swallowed a few lines earlier and the brief is generated ungrounded, so
    // an operator could restore the tool by breaking the digest harder. The
    // brief comes from a different upstream; the digest is only grounding.
    // Default now: drop the stale grounding, still answer, and report what
    // happened in digestCoverage so the caller can apply its own policy.
    const digestCoverage = {
      state: 'stale',
      servedStale: true,
      staleAgeSeconds: 900,
      staleReason: 'empty-rebuild',
      attemptedAt: '2026-08-10T02:05:00.000Z',
    };
    const calls = stubDownstream({ digestItems: [digestItem()], digestCoverage });

    const rpc = await callCountryBriefRpc();

    assert.equal(rpc.error, undefined, 'a stale digest must not fail the whole tool call');
    assert.ok(
      calls.some(call => call.pathname === '/api/intelligence/v1/get-country-intel-brief'),
      'the brief itself still has to be generated',
    );

    const payload = JSON.parse(rpc.result.content[0].text);
    assert.deepEqual(payload.groundingStories, [], 'stale digest grounding is dropped, not used');
    // `sources` here is the GATEWAY's own source list, a different upstream
    // that this drop does not touch — only the digest-derived grounding goes.
    assert.deepEqual(
      payload.sources.map((entry) => entry.url), ['https://example.com/upstream'],
      'the gateway source list is unaffected',
    );
    assert.equal(
      payload.digestCoverage?.servedStale, true,
      'the caller must still learn the grounding was withheld and why',
    );
    assert.equal(payload.digestCoverage?.staleAgeSeconds, 900);

    const briefCall = calls.find(call => call.pathname === '/api/intelligence/v1/get-country-intel-brief');
    assert.ok(
      !String(briefCall?.body ?? '').includes('retained snapshot'),
      'the stale headlines must not reach the LLM prompt when allow_stale is not set',
    );
  });

  it('allows explicit stale grounding and returns structured digest coverage', async () => {
    const digestCoverage = {
      state: 'stale',
      servedStale: true,
      staleAgeSeconds: 900,
      staleReason: 'feed_timeout',
      attemptedAt: '2026-08-10T02:05:00.000Z',
    };
    const calls = stubDownstream({ digestItems: [digestItem()], digestCoverage });

    const payload = await callCountryBrief({ country_code: 'FR', allow_stale: true });

    assert.deepEqual(payload.digestCoverage, digestCoverage);
    const briefCall = calls.find(call => call.pathname === '/api/intelligence/v1/get-country-intel-brief');
    assert.ok(briefCall, 'explicit stale opt-in should reach the LLM brief endpoint');
    assert.match(JSON.parse(String(briefCall.init.body)).context, /retained snapshot/i);
  });

  it('returns structured digest coverage for fresh grounding', async () => {
    const digestCoverage = {
      state: 'complete',
      servedStale: false,
      staleAgeSeconds: 0,
      staleReason: '',
      attemptedAt: '2026-08-10T02:05:00.000Z',
    };
    stubDownstream({ digestItems: [digestItem()], digestCoverage });

    const payload = await callCountryBrief();

    assert.equal(payload.brief, 'Synthesized country brief.');
    assert.deepEqual(payload.digestCoverage, digestCoverage);
  });

  it('grounds through the shared matcher: demonyms count, a bare ISO code does not', async () => {
    // The tool's own term list matched the code case-insensitively, so
    // "rally in Europe" grounded India (#7748). Now shared/country-mention.js.
    stubDownstream({
      digestItems: [
        digestItem({ title: 'French regulator opens inquiry into port fees', link: 'https://example.com/fr-demonym' }),
        digestItem({ title: 'FR ministry raises target', link: 'https://example.com/fr-code' }),
        digestItem({ title: 'Markets rally in Europe on rate-cut hopes', link: 'https://example.com/eu' }),
      ],
    });

    const payload = await callCountryBrief();

    assert.deepEqual(
      payload.groundingStories.map((story) => story.url),
      ['https://example.com/fr-demonym'],
      'only the demonym-matched story grounds the brief',
    );
  });

  it('grounds on nothing when the country\'s only mentions are sports items', async () => {
    // The tool used to fall back to the top global items when no item matched
    // the country, and it never filtered sports: a football score grounded
    // Burkina Faso's brief. Zero relevant mentions now means zero grounding.
    const calls = stubDownstream({
      digestItems: [
        digestItem({ title: 'France beat Portugal in World Cup qualifier', link: 'https://example.com/fr-football' }),
        digestItem({ title: 'Markets rally in Europe on rate-cut hopes', link: 'https://example.com/eu' }),
      ],
    });

    const payload = await callCountryBrief();

    assert.deepEqual(payload.groundingStories, [], 'no sports item and no global item may ground the brief');
    const briefCall = calls.find(call => call.pathname === '/api/intelligence/v1/get-country-intel-brief');
    assert.equal(
      JSON.parse(String(briefCall.init.body)).context, undefined,
      'no grounding context may reach the brief endpoint',
    );
  });

  it('keeps relevant country items while dropping the country\'s sports items', async () => {
    const calls = stubDownstream({
      digestItems: [
        digestItem({ title: 'France beat Portugal in World Cup qualifier', link: 'https://example.com/fr-football' }),
        digestItem(),
      ],
    });

    const payload = await callCountryBrief();

    assert.deepEqual(payload.groundingStories.map((story) => story.url), ['https://example.com/fr-energy']);
    const briefCall = calls.find(call => call.pathname === '/api/intelligence/v1/get-country-intel-brief');
    assert.doesNotMatch(JSON.parse(String(briefCall.init.body)).context, /World Cup/);
  });

  it('emits groundingStories even when the upstream supplies its own sources', async () => {
    // The decision this pins: sources keeps the gateway's proto BriefSource
    // list untouched, and corroboration arrives on a sibling field that is
    // still populated on that path.
    stubDownstream({ digestItems: [digestItem()] });

    const payload = await callCountryBrief();

    assert.deepEqual(
      payload.sources.map((s) => s.title),
      ['Upstream server-side grounding article'],
      'sources must still be the upstream citation list',
    );
    assert.deepEqual(payload.groundingStories, [{
      title: 'France announces new energy package',
      source: 'Example Wire',
      url: 'https://example.com/fr-energy',
      publishedAt: '2026-08-10T00:00:00.000Z',
      corroborationCount: 4,
      corroboration: { state: 'corroborated', publishers: 4 },
      sourceProvenance: compactProvenance('Example Wire'),
      publishers: [{ name: 'Example Wire', tier: null, labels: ['Example Wire'], labelsUnlisted: 0 }],
      publishersUnlisted: 3,
      mentionCount: 3,
      storyPhase: 'STORY_PHASE_DEVELOPING',
    }]);
  });

  it('flags a grounding story carried by one publisher (#6419)', async () => {
    stubDownstream({ digestItems: [digestItem({ title: 'France single outlet item', corroborationCount: 1 })] });

    const payload = await callCountryBrief();

    assert.deepEqual(payload.groundingStories[0].corroboration, { state: 'single-publisher', publishers: 1 });
  });

  it('drops digest items that carry no corroboration metadata', async () => {
    // A digest predating the story-identity service has neither field. Emitting
    // a row of zeroes for it would read as "single unconfirmed source", which
    // is a claim we cannot make; omission is the honest answer.
    stubDownstream({
      digestItems: [
        { title: 'France legacy item, no story tracking', source: 'Old Wire', link: 'https://example.com/legacy' },
        digestItem({ title: 'France tracked item', corroborationCount: 7 }),
      ],
    });

    const payload = await callCountryBrief();

    assert.deepEqual(payload.groundingStories.map((s) => s.title), ['France tracked item']);
    assert.equal(payload.groundingStories[0].corroborationCount, 7);
  });

  it('returns an empty groundingStories when the digest read fails', async () => {
    // The brief is still produced without grounding context; an empty array is
    // the signal that no corroboration was observed, not that there was none.
    stubDownstream({ digestItems: [], digestOk: false });

    const payload = await callCountryBrief();

    assert.equal(payload.brief, 'Synthesized country brief.');
    assert.deepEqual(payload.groundingStories, []);
    assert.equal(payload.digestCoverage, undefined);
  });

  it('caps groundingStories at six and dedupes repeated titles', async () => {
    const items = Array.from({ length: 9 }, (_, i) => digestItem({
      title: `France story ${i}`,
      link: `https://example.com/s${i}`,
      corroborationCount: i,
    }));
    // A duplicate title is the same story reaching the digest twice.
    items.push(digestItem({ title: 'France story 0', link: 'https://example.com/dupe' }));
    stubDownstream({ digestItems: items });

    const payload = await callCountryBrief();

    assert.equal(payload.groundingStories.length, 6);
    assert.deepEqual(
      payload.groundingStories.map((s) => s.title),
      ['France story 0', 'France story 1', 'France story 2', 'France story 3', 'France story 4', 'France story 5'],
    );
  });

  it('omits optional fields rather than emitting undefined placeholders', async () => {
    stubDownstream({
      digestItems: [{
        title: 'France corroboration count only',
        source: 'Example Wire',
        link: 'https://example.com/count-only',
        corroborationCount: 2,
      }],
    });

    const payload = await callCountryBrief();

    assert.deepEqual(payload.groundingStories, [{
      title: 'France corroboration count only',
      source: 'Example Wire',
      url: 'https://example.com/count-only',
      corroborationCount: 2,
      corroboration: { state: 'corroborated', publishers: 2 },
      sourceProvenance: compactProvenance('Example Wire'),
      publishers: [{ name: 'Example Wire', tier: null, labels: ['Example Wire'], labelsUnlisted: 0 }],
      publishersUnlisted: 1,
    }]);
  });

  it('omits oversized grounding URLs before the serialized response exceeds its budget', async () => {
    const longUrls = Array.from({ length: 6 }, (_, i) => (
      `https://example.com/${'x'.repeat(6_000)}-${i}`
    ));
    stubDownstream({
      digestItems: longUrls.map((link, i) => digestItem({
        title: `France grounding story ${i}`,
        link,
      })),
      // Keep the canonical citation URLs present. The regression was the new
      // groundingStories field duplicating all six and crossing the 64 KB cap.
      briefSources: longUrls.map((link, i) => ({
        title: `France grounding story ${i}`,
        source: 'Example Wire',
        link,
      })),
    });

    const { payload, rawText } = await callCountryBriefResult();

    assert.equal(payload._budget_exceeded, undefined, 'response must not be replaced by the budget guard');
    assert.equal(payload.sources.length, 6, 'canonical citations remain available');
    assert.equal(payload.groundingStories.length, 6);
    assert.ok(payload.groundingStories.every((story) => story.url === undefined));
    assert.ok(
      Buffer.byteLength(rawText, 'utf8') < 65_536,
      `serialized country brief is ${Buffer.byteLength(rawText, 'utf8')} bytes, over the 65536 budget`,
    );
  });

  it('fits six citations and full bounded publisher rosters with registry provenance under the tool budget', async () => {
    const source = Object.keys(SOURCE_PROPAGANDA_RISK).sort((a, b) =>
      Buffer.byteLength(JSON.stringify(getSourceProvenanceState(b))) - Buffer.byteLength(JSON.stringify(getSourceProvenanceState(a))),
    )[0];
    const primary = Array.from({ length: 6 }, (_, i) => digestItem({
      title: `France ${i} ${'界'.repeat(160)}`,
      source,
      link: `https://example.com/${'x'.repeat(6_000)}-${i}`,
      corroborationCount: 12,
    }));
    const labels = Array.from({ length: 9 }, (_, i) => `${i}${'a'.repeat(39)}`);
    const siblings = primary.flatMap(item => labels.flatMap(label => [
      label, label.toUpperCase(), `${label.slice(0, 2).toUpperCase()}${label.slice(2)}`,
      `${label.slice(0, 3).toUpperCase()}${label.slice(3)}`, `${label.slice(0, 4).toUpperCase()}${label.slice(4)}`,
    ].map(source => ({ ...item, source }))));
    stubDownstream({ digestItems: [...primary, ...siblings], briefSources: primary, briefExtras: { brief: 'b'.repeat(4_000) } });
    const { payload, rawText } = await callCountryBriefResult();
    assert.equal(payload._budget_exceeded, undefined, JSON.stringify(payload));
    assert.equal(payload.sources.length, 6);
    assert.equal(payload.groundingStories.length, 6);
    for (const story of payload.groundingStories) {
      assert.equal(story.publishers.length, 8);
      assert.equal(story.publishersUnlisted, 4);
      assert.ok(story.publishers.some(publisher => publisher.labels.length === 4 && publisher.labelsUnlisted === 1));
      assert.deepEqual(story.sourceProvenance, compactProvenance(source));
    }
    const tool = __testing__.TOOL_REGISTRY.find(candidate => candidate.name === 'get_country_brief');
    const bytes = Buffer.byteLength(rawText, 'utf8');
    assert.ok(bytes < tool._outputBudgetBytes, `${bytes} bytes must fit ${tool._outputBudgetBytes}`);
    process.stdout.write(`Country brief maximum-list fixture: ${bytes}/${tool._outputBudgetBytes} bytes\n`);
  });
});
