// Run with: npm test (node --import tsx, so WorldMonitor's TypeScript modules load).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Anchor } from '../lib/anchor.mjs';
import { gradeToResult } from '../lib/grade.mjs';
import { WorldMonitorMcp } from '../lib/mcp-client.mjs';
import { findRevealCandidates } from '../lib/reveal.mjs';
import { ArchiveSource, CombinedSource, LiveSource } from '../lib/sources.mjs';
import { heuristicSearchTerms, overlapScore } from '../lib/text.mjs';
import { computeVerdict } from '../lib/verdict.mjs';
import { coverage, credibilityBand, groundFigures, ratePublishers, sourceCredibility, validateScript, WM_TEXT } from '../lib/wm.mjs';
import { computeCredibilityScore } from '../../../shared/news-credibility.js';
import { getSourceTier } from '../../../server/_shared/source-tiers.ts';
import { getSourcePropagandaRisk } from '../../../shared/source-provenance.ts';

const anchor = new Anchor({ apiKey: '' });
const snapshotDesk = () => ({
  source: new CombinedSource(null, new ArchiveSource([new URL('../snapshots', import.meta.url).pathname], { days: 100000 })),
  anchor,
});

test('the bridge calls WorldMonitor, it does not re-implement it', () => {
  // Same composition as the dashboard's resolveCredibilityScore.
  for (const name of ['AP News', 'Daily Sabah', 'RT', 'Hacker News', 'Some Unlisted Blog']) {
    assert.equal(sourceCredibility(name, 3), computeCredibilityScore({
      sourceTier: getSourceTier(name), propagandaRisk: getSourcePropagandaRisk(name).risk, independentCorroborationCount: 3,
    }));
  }
  // The dashboard's badge bands.
  assert.deepEqual([39, 40, 69, 70].map(credibilityBand), ['low', 'medium', 'medium', 'high']);
  // WorldMonitor's own UI wording.
  assert.equal(WM_TEXT.singlePublisher, 'Single publisher');
  assert.equal(WM_TEXT.tier4Only, 'Low-tier sources only');
});

test('coverage: feed labels of one newsroom are one publisher; aggregators alone are low-tier only', () => {
  assert.equal(coverage(['Reuters India', 'Reuters US'], null).verdict.state, 'single-publisher');
  assert.equal(coverage(['Hacker News', 'The Verge'], null).verdict.state, 'tier4-only');
  const c = coverage(['AP News', 'BBC World', 'Daily Sabah'], null);
  assert.equal(c.verdict.state, 'corroborated');
  const rated = ratePublishers(c.roster, c.verdict.publishers);
  assert.equal(rated[0].tier, 1); // roster order: best tier first
  assert.equal(rated.find((r) => r.name === 'Daily Sabah').stateAffiliated, 'Turkey');
});

test('figures go through the brief seeders\' grounding gate', () => {
  const quake = groundFigures('Panama earthquake kills 200', 'Magnitude 7.7 earthquake hits Panama');
  assert.equal(quake.gate, 'ungrounded');
  assert.deepEqual(quake.facts.map((f) => [f.label, f.grounded]), [['200', false]]);
  assert.equal(groundFigures('Strike ends after nine days', 'ending a strike that lasted 9 days').gate, 'grounded');
});

test('generated anchor scripts must pass WorldMonitor\'s brief validators', () => {
  const ground = 'Daily Sabah reports 31 civilians killed in Sudan';
  assert.equal(validateScript('Daily Sabah reports 31 civilians killed.', ground).ok, true);
  assert.equal(validateScript('Reuters confirms 31 civilians killed.', ground).ok, false);
  assert.equal(validateScript('Daily Sabah reports 40 civilians killed.', ground).ok, false);
});

test('verdict card is WorldMonitor\'s judgments, arranged', () => {
  assert.equal(computeVerdict({ found: false }).word, 'Not in WorldMonitor’s sources');
  assert.match(computeVerdict({ found: false, sourcesUnreachable: true }).reasons[0], /could not reach/);
  const single = computeVerdict({ found: true, coverage: { state: 'single-publisher', publishers: 1 } });
  assert.equal(single.word, WM_TEXT.singlePublisher);
  assert.equal(single.hint, WM_TEXT.singlePublisherHint);
});

test('retrieval: paraphrases match, unrelated headlines do not', () => {
  assert.ok(overlapScore('Calloway resigns as minister', 'Minister Calloway to resign within days') >= 0.5);
  assert.ok(overlapScore('Aliens land in Paris', 'Minister Calloway to resign within days') < 0.2);
  assert.ok(heuristicSearchTerms('Trump strikes diesel deal with Putin').includes('Trump'));
});

// Real WorldMonitor data captured 2026-10-09 (snapshots/).
test('real snapshot: split clusters, ungrounded figures, state media, single publishers', async () => {
  const deps = snapshotDesk();
  const diesel = await gradeToResult('Trump strikes diesel deal with Putin', deps);
  assert.equal(diesel.verdict.key, 'corroborated');
  assert.ok(diesel.who.coverage.publishers >= 5, 'the diesel deal sat in several one-outlet clusters');
  assert.ok(diesel.match.mergedClusters > 1);

  const quake = await gradeToResult('Panama earthquake kills 200', deps);
  assert.equal(quake.numbers.gate, 'ungrounded');
  assert.ok(quake.verdict.reasons.some((r) => /200 is not grounded/.test(r)));

  const sudan = await gradeToResult('31 civilians killed in drone strike on Sudan displacement camp', deps);
  assert.equal(sudan.who.rated.find((r) => r.name === 'Daily Sabah').stateAffiliated, 'Turkey');
  assert.deepEqual(sudan.numbers.facts[0].statedBy, ['Daily Sabah']);

  const nvidia = await gradeToResult("Nvidia's communications chief leaves", deps);
  assert.equal(nvidia.verdict.word, 'Single publisher');

  const none = await gradeToResult('Apple buys Netflix', deps);
  assert.equal(none.verdict.key, 'not-found');
});

test('reveal: WorldMonitor counts six iHeart station sites as one publisher', async () => {
  const [top] = await findRevealCandidates(snapshotDesk().source);
  assert.equal(top.pattern, 'syndication');
  assert.equal(top.headlineCount, 6);
  assert.equal(top.publishers, 1);
  assert.equal(top.groundingGap, 'thin-grounding');
});

test('an outage is reported as an outage, never as "nobody carried it"', async () => {
  const mcp = { async callTool() { throw new Error('fetch failed'); } };
  const r = await gradeToResult('Trump strikes diesel deal', { source: new CombinedSource(new LiveSource(mcp), null), anchor });
  assert.equal(r.verdict.key, 'unreachable');
  assert.match(r.script, /can't reach WorldMonitor/);
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
  assert.deepEqual(await mcp.callTool('get_news_clusters', { query: 'x' }), { clusters: [{ id: 'c1' }] });
  assert.equal(calls.at(-1).headers['Mcp-Session-Id'], 'sess-1');
  assert.equal(calls.at(-1).headers['X-WorldMonitor-Key'], 'k');
});

test('today\'s board: one event across clusters is one story, graded by WorldMonitor', async () => {
  const { buildBoard } = await import('../lib/board.mjs');
  const { clusters, from } = await snapshotDesk().source.boardClusters();
  assert.equal(from, 'archive');
  const b = buildBoard(clusters);
  const diesel = b.supported.find((s) => /diesel/i.test(s.title));
  assert.ok(diesel && diesel.clusters >= 5 && diesel.publishers >= 5, 'the split diesel clusters are one corroborated story');
  assert.ok(b.thin.some((s) => /Yandex/.test(s.title) && s.state === 'single-publisher'));
  assert.equal(b.totals.corroborated + b.totals.singlePublisher + b.totals.lowTierOnly + b.totals.unknown, b.totals.stories);
  // Every board story can be checked: it is findable by the grader.
  const r = await gradeToResult(b.thin[0].title, snapshotDesk());
  assert.notEqual(r.verdict.key, 'not-found');
});
