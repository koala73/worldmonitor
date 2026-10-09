import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Anchor } from '../lib/anchor.mjs';
import { gradeToResult } from '../lib/grade.mjs';
import { WorldMonitorMcp } from '../lib/mcp-client.mjs';
import { findRevealCandidates } from '../lib/reveal.mjs';
import { FixtureSource } from '../lib/sources.mjs';
import { attributionCascade, attributionOf, checkFigures, extractFigures, overlapScore } from '../lib/text.mjs';
import { computeVerdict, gateJudge } from '../lib/verdict.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/rehearsal.json', import.meta.url), 'utf8'));
const desk = () => ({ source: new FixtureSource(fixture), anchor: new Anchor({ apiKey: '' }) });

test('figures: scale words, commas and percent are normalised', () => {
  assert.deepEqual(extractFigures('3 million accounts').map((f) => f.value), [3e6]);
  assert.deepEqual(extractFigures('3,000,000 accounts').map((f) => f.value), [3e6]);
  assert.equal(extractFigures('up 6%')[0].percent, true);
  assert.equal(checkFigures('Breach hits 3 million users', 'about 3,000,000 accounts')[0].found, true);
});

test('figures: a different figure in the sources is reported, a missing one is unproven', () => {
  const [conflict] = checkFigures('rates up 75 basis points', 'raised by 50 basis points');
  assert.equal(conflict.found, false);
  assert.equal(conflict.sourcesSay, '50');
  const [missing] = checkFigures('eruption kills 400', 'villages evacuated');
  assert.deepEqual([missing.found, missing.sourcesSay], [false, null]);
});

test('attribution: named origins and cascades', () => {
  assert.equal(attributionOf('Lumora hit by breach, Kestrel Wire reports'), 'Kestrel Wire');
  assert.equal(attributionOf('Leak confirmed, according to Kestrel Wire'), 'Kestrel Wire');
  assert.equal(attributionOf('Port reopens after strike'), null);
  const c = attributionCascade(fixture.clusters.find((x) => x.id === 'reh-lumora').memberTitles);
  assert.equal(c.origin, 'Kestrel Wire');
  assert.ok(c.originCount >= 5);
});

test('matching tolerates paraphrase and rejects unrelated headlines', () => {
  assert.ok(overlapScore('Calloway resigns as minister', 'Minister Calloway to resign within days') >= 0.5);
  assert.ok(overlapScore('Aliens land in Paris', 'Minister Calloway to resign within days') < 0.2);
});

test('verdict rule: counts decide, never the model', () => {
  const m = { score: 0.9 };
  assert.equal(computeVerdict({ match: null }).verdict, 'Unverifiable');
  assert.equal(computeVerdict({ match: m, corroboration: { state: 'corroborated', publishers: 4 } }).verdict, 'Corroborated');
  assert.equal(computeVerdict({ match: m, corroboration: { state: 'single-publisher', publishers: 1 } }).verdict, 'Single-source');
  assert.equal(computeVerdict({ match: m, corroboration: { state: 'tier4-only', publishers: 3 } }).verdict, 'Unverifiable');
  assert.equal(computeVerdict({ match: m, corroboration: { state: 'unknown', publishers: null } }).verdict, 'Unverifiable');
  assert.equal(
    computeVerdict({ match: m, corroboration: { state: 'corroborated', publishers: 4 }, figures: [{ figure: '75', found: false, sourcesSay: '50' }] }).verdict,
    'Contradicted',
  );
});

test('judge gate: a contradiction without a verbatim quote is discarded', () => {
  const evidence = 'The bank raised its rate by 50 basis points on Tuesday.';
  assert.equal(gateJudge({ stance: 'contradicts', quote: 'raised its rate by 50 basis points' }, evidence).stance, 'contradicts');
  assert.equal(gateJudge({ stance: 'contradicts', quote: 'the bank cut rates' }, evidence).stance, 'insufficient');
  assert.equal(gateJudge({ stance: 'made-up', quote: null }, evidence).stance, 'insufficient');
});

test('grade pipeline end to end on rehearsal data, template voice', async () => {
  const cases = [
    ['Minister Calloway resigns', 'Single-source'],
    ['Aurelia central bank raises rates by 75 basis points', 'Contradicted'],
    ['Port Veridia strike ends after 9 days', 'Corroborated'],
    ['Aliens land in Paris', 'Unverifiable'],
  ];
  for (const [headline, expected] of cases) {
    const r = await gradeToResult(headline, desk());
    assert.equal(r.verdict.verdict, expected, headline);
    assert.match(r.script, new RegExp(`Verdict: ${expected}`));
  }
  const tessaly = await gradeToResult('Mount Tessaly eruption kills 400', desk());
  assert.equal(tessaly.verdict.verdict, 'Corroborated');
  assert.equal(tessaly.verdict.caveat, 'Story corroborated, figure unproven');
});

test('reveal finder surfaces the one-origin stories first', async () => {
  const candidates = await findRevealCandidates(new FixtureSource(fixture));
  const patterns = candidates.map((c) => `${c.pattern}:${c.origin}`);
  assert.ok(patterns.includes('cascade:Kestrel Wire'));
  assert.ok(patterns.includes('echo:Northgate Herald'));
  assert.ok(!candidates.some((c) => c.title.includes('Port Veridia')));
});

test('MCP client: initialize, session header, SSE tool result', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, headers: init.headers });
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } });
    }
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    const payload = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ clusters: [{ id: 'c1' }] }) }] } };
    return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const mcp = new WorldMonitorMcp({ apiKey: 'k', fetchImpl });
  const out = await mcp.callTool('get_news_clusters', { query: 'x' });
  assert.deepEqual(out, { clusters: [{ id: 'c1' }] });
  assert.equal(calls.at(-1).headers['Mcp-Session-Id'], 'sess-1');
  assert.equal(calls.at(-1).headers['X-WorldMonitor-Key'], 'k');
});

test('live path: clusters by query, intelligence and markets read once per TTL', async () => {
  const { LiveSource, CombinedSource } = await import('../lib/sources.mjs');
  const counts = {};
  const cluster = { ...fixture.clusters.find((c) => c.id === 'reh-calloway'), memberTitles: undefined };
  const mcp = {
    async callTool(name, args) {
      counts[name] = (counts[name] ?? 0) + 1;
      if (name === 'get_news_clusters') return { clusters: args.query && cluster.title.toLowerCase().includes(args.query.toLowerCase()) ? [cluster] : [], generatedAt: 'now' };
      // cache-tool envelopes nest the payload; the desk must dig for it
      if (name === 'get_news_intelligence') return { data: { insights: { topStories: [{ primaryTitle: cluster.title, memberTitles: fixture.clusters[1].memberTitles, uniqueSourceCount: 1 }] } } };
      if (name === 'get_prediction_markets') return { data: { 'markets-bootstrap': { geopolitical: fixture.markets } } };
      throw new Error(`unexpected ${name}`);
    },
  };
  const source = new CombinedSource(new LiveSource(mcp), null);
  const deps = { source, anchor: new Anchor({ apiKey: '' }) };
  const a = await gradeToResult('Minister Calloway resigns', deps);
  const b = await gradeToResult('Calloway to resign within days', deps);
  assert.equal(a.verdict.verdict, 'Single-source');
  assert.equal(b.verdict.verdict, 'Single-source');
  assert.equal(a.when.cascade.origin, 'Northgate Herald');
  assert.equal(a.money.markets[0].yesPrice, 18);
  assert.equal(counts.get_news_intelligence, 1);
  assert.equal(counts.get_prediction_markets, 1);
});

test('an outage is reported as an outage, never as "nobody carried it"', async () => {
  const { LiveSource, CombinedSource } = await import('../lib/sources.mjs');
  const mcp = { async callTool() { throw new Error('fetch failed'); } };
  const r = await gradeToResult('Minister Calloway resigns', { source: new CombinedSource(new LiveSource(mcp), null), anchor: new Anchor({ apiKey: '' }) });
  assert.equal(r.verdict.verdict, 'Unverifiable');
  assert.match(r.verdict.reasons[0], /could not reach/);
  assert.match(r.script, /can't reach its sources/);
});

// Regression cases from real WorldMonitor data captured 2026-10-09 (snapshots/).
test('real 2026-10-09 snapshot: split clusters, unrelated figures, one-publisher numbers, syndication', async () => {
  const { ArchiveSource, CombinedSource } = await import('../lib/sources.mjs');
  const archive = new ArchiveSource([new URL('../snapshots', import.meta.url).pathname], { days: 100000 });
  const deps = { source: new CombinedSource(null, archive), anchor: new Anchor({ apiKey: '' }) };

  // The diesel deal sat in 8 one-outlet clusters; counting one cluster would say Single-source.
  const diesel = await gradeToResult('Trump strikes diesel deal with Putin', deps);
  assert.equal(diesel.verdict.verdict, 'Corroborated');
  assert.ok(diesel.who.families >= 5);

  // "magnitude 7.7" must not contradict "kills 200": different quantities.
  const quake = await gradeToResult('Panama earthquake kills 200', deps);
  assert.equal(quake.verdict.verdict, 'Corroborated');
  assert.equal(quake.verdict.caveat, 'Story corroborated, figure unproven');

  // Two outlets report the strikes; only one states the number.
  const sudan = await gradeToResult('31 civilians killed in drone strike on Sudan displacement camp', deps);
  assert.deepEqual(sudan.numbers.figures[0].statedBy, ['Daily Sabah']);
  assert.equal(sudan.verdict.caveat, 'Story corroborated, figure single-source');

  const [top] = await findRevealCandidates(deps.source);
  assert.equal(top.pattern, 'syndication');
  assert.equal(top.origin, 'iheart.com');
  assert.equal(top.headlineCount, 6);
});
