// Run with: npm test (node --import tsx, so WorldMonitor's TypeScript modules load).
import assert from 'node:assert/strict';
import path from 'node:path';
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

test('the board is dated by its data, and a presenter refresh refetches', async () => {
  // Archive: the newest snapshot's time, never the request time.
  const archived = await snapshotDesk().source.boardClusters();
  assert.equal(Date.parse(archived.asOf), Date.parse('2026-10-09T21:10:10.756Z'));
  // Live: cached for the TTL, refetched when forced.
  let calls = 0;
  const mcp = { async callTool(name) { calls += 1; return name === 'get_news_intelligence' ? { topStories: [] } : { clusters: [{ id: 'c1', title: 'A', sources: ['BBC'] }] }; } };
  const live = new CombinedSource(new LiveSource(mcp), null);
  await live.boardClusters();
  await live.boardClusters();
  assert.equal(calls, 2, 'two calls, then the cache');
  const forced = await live.boardClusters({ force: true });
  assert.equal(calls, 4, 'a forced refresh makes both calls again');
  assert.equal(forced.from, 'live');
  assert.ok(Date.parse(forced.asOf) > 0);
});

test('offline rehearsal makes no network calls', async () => {
  const { buildDesk } = await import('../lib/config.mjs');
  const desk = buildDesk({ offline: true });
  assert.equal(desk.noNetwork, true);
  assert.equal(desk.anchor.enabled, false, 'no Claude offline');
  assert.equal(await desk.source.articleText('https://example.com/story'), null, 'no article fetch offline');
});

test('a fetched article is credited to the publisher of its own link', async () => {
  // Two clusters of one event: the best match (Daily Sabah, the link) and a tier-1 wire.
  const clusters = [
    { id: 'a', title: 'Drone strike on Sudan camp kills 31 civilians', link: 'https://dailysabah.example/a', primarySource: 'Daily Sabah', sources: ['Daily Sabah'], publishers: [{ name: 'Daily Sabah', labels: ['Daily Sabah'] }] },
    { id: 'b', title: 'Drone strike on Sudan displacement camp kills civilians', link: 'https://apnews.example/b', primarySource: 'AP News', sources: ['AP News'], publishers: [{ name: 'AP News', labels: ['AP News'] }] },
  ];
  const source = {
    kind: 'archive',
    async searchClusters() { return { clusters, generatedAt: null, failures: [] }; },
    async allClusters() { return clusters; },
    async intelligenceStories() { return []; },
    async storyDetail() { return null; },
    async markets() { return []; },
    async weekClusters() { return []; },
    async articleText(url) { return url.includes('dailysabah') ? 'At least 31 people were killed.' : null; },
  };
  const r = await gradeToResult('Drone strike on Sudan camp kills 31 civilians', { source, anchor });
  const fact = r.numbers.facts.find((f) => f.label === '31');
  assert.ok(fact, JSON.stringify(r.numbers));
  assert.deepEqual(fact.statedBy, ['Daily Sabah'], 'the wire never stated 31; only the linked article and its own headline did');
});

test('article text: scripts with spaced end tags are dropped, entities decode once', async () => {
  const { fetchArticleText } = await import('../lib/sources.mjs');
  const body = `<p>Officials said 31 people died.</p><script>var x = "200 dead";</script ><style>.a{}</style >
    <p>Tom &amp;lt;Jerry&amp;gt; &quot;quoted&quot; &amp; more ${'filler text '.repeat(30)}</p>`;
  const text = await fetchArticleText('https://example.com/a', { fetchImpl: async () => ({ ok: true, text: async () => body }) });
  assert.ok(text.includes('31 people died'));
  assert.ok(!text.includes('200'), 'script content is not article text');
  assert.ok(text.includes('Tom &lt;Jerry&gt; "quoted" & more'), text.slice(0, 120));
});

test('committed snapshots never age out; rolling archives do', async () => {
  const dir = new URL('../snapshots', import.meta.url).pathname;
  const expired = await new ArchiveSource([dir], { days: 0.001 }).load();
  assert.equal(expired.clusters.length, 0, 'a short window drops the snapshot');
  const kept = await new ArchiveSource([{ dir, days: Infinity }], { days: 0.001 }).load();
  assert.ok(kept.clusters.length > 0, 'a directory with no cutoff keeps it');
  const { buildDesk } = await import('../lib/config.mjs');
  const { clusters } = await buildDesk({ offline: true }).source.boardClusters();
  assert.ok(clusters.length > 0, 'the offline board has data whatever the date');
});

test('a failed snapshot load is remembered for a minute, then WorldMonitor is asked again', async () => {
  const { FAILURE_TTL_MS } = await import('../lib/sources.mjs');
  let calls = 0;
  const mcp = { async callTool() { calls += 1; throw new Error('fetch failed'); } };
  const live = new LiveSource(mcp);
  assert.deepEqual(await live.markets(['x']).catch(() => 'threw'), 'threw', 'a failed markets load throws to the caller');
  await live.markets(['x']).catch(() => {});
  await live.markets(['x']).catch(() => {});
  assert.equal(calls, 1, 'the failure is cached: no second timeout on the next check');
  live.snapshots.get('markets').at -= FAILURE_TTL_MS + 1;
  await live.markets(['x']).catch(() => {});
  assert.equal(calls, 2, 'after the failure TTL WorldMonitor is asked again');
  // A refresh that fails keeps the last good value instead of throwing.
  let ok = true;
  const flaky = { async callTool() { if (!ok) throw new Error('fetch failed'); return { topStories: [{ primaryTitle: 'A' }] }; } };
  const src = new LiveSource(flaky);
  assert.equal((await src.intelligenceStories()).length, 1);
  ok = false;
  assert.equal((await src.intelligencePayload({ force: true })).stories.length, 1, 'the last good snapshot stands in');
});

test('an over-budget tool result is an error, never an empty board', async () => {
  const envelope = { _budget_exceeded: true, budget_bytes: 131072, actual_bytes: 200000, hint: 'use jmespath' };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 's' } });
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope } }), { headers: { 'content-type': 'application/json' } });
  };
  const mcp = new WorldMonitorMcp({ apiKey: 'k', fetchImpl });
  await assert.rejects(() => mcp.callTool('get_news_intelligence', { limit: 0 }), /exceeds WorldMonitor's tool output budget/);
  // The whole-snapshot tools are capped so the budget is not reached in the first place.
  const seen = [];
  const capped = { async callTool(name, args) { seen.push([name, args.limit]); return name === 'get_news_intelligence' ? { topStories: [] } : { clusters: [] }; } };
  const live = new LiveSource(capped);
  await live.intelligenceStories();
  await live.markets([]);
  assert.equal(seen.length, 2);
  for (const [name, limit] of seen) assert.ok(limit > 0, `${name} is called with a cap, got ${limit}`);
});

test('a board that is not live is narrated as a dated snapshot, never as "right now"', async () => {
  const { templateBoard } = await import('../lib/anchor.mjs');
  const b = { totals: { stories: 12, corroborated: 6, singlePublisher: 6 }, supported: [], thin: [], asOf: '2026-10-09T21:10:10.756Z' };
  assert.match(templateBoard({ ...b, from: 'live' }), /^Good evening.*Right now WorldMonitor is tracking 12 stories/);
  const archived = templateBoard({ ...b, from: 'archive' });
  assert.doesNotMatch(archived, /right now|today/i);
  assert.match(archived, /last snapshot, from Saturday 10 October at 01:10/);
  assert.doesNotMatch(templateBoard({ ...b, from: 'live', fromCache: true, cacheSavedAt: '2026-10-09T21:10:10.756Z' }), /right now/i);
});

test('the grade stream stops at the next step once the browser is gone', async () => {
  // server.mjs breaks out of gradeHeadline when `res` closes; the generator's
  // early return must not continue to later (paid) steps.
  const calls = [];
  const mcp = { async callTool(name) { calls.push(name); return { clusters: [{ id: 'c1', title: 'Trump strikes diesel deal with Putin', sources: ['BBC', 'CNBC'], link: 'https://www.bbc.com/x' }], topStories: [] }; } };
  const { gradeHeadline } = await import('../lib/grade.mjs');
  const it = gradeHeadline('Trump strikes diesel deal with Putin', { source: new CombinedSource(new LiveSource(mcp), null), anchor });
  const first = await it.next();
  assert.equal(first.value.step, 'match');
  await it.return();
  const after = calls.length;
  assert.equal((await it.next()).done, true);
  assert.equal(calls.length, after, 'no further WorldMonitor calls after the stream is abandoned');
});

test('the repo .env.local backs the demo .env, and an empty assignment never blocks it', async () => {
  const { loadEnv, envFiles } = await import('../lib/config.mjs');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desk-env-'));
  const demo = path.join(dir, '.env');
  const repo = path.join(dir, '.env.local');
  await writeFile(demo, 'DESK_T_A=\nDESK_T_B=demo\n');
  await writeFile(repo, 'DESK_T_A=repo\nDESK_T_B=repo\nDESK_T_C=repo\n');
  for (const k of ['DESK_T_A', 'DESK_T_B', 'DESK_T_C', 'DESK_T_D']) delete process.env[k];
  process.env.DESK_T_D = 'shell';
  loadEnv([demo, repo, path.join(dir, 'missing')]);
  assert.equal(process.env.DESK_T_A, 'repo', 'an empty line in the demo .env (as in .env.example) does not block the repo value');
  assert.equal(process.env.DESK_T_B, 'demo', 'the demo .env wins over the repo file');
  assert.equal(process.env.DESK_T_C, 'repo', 'a key only in the repo file is picked up');
  assert.equal(process.env.DESK_T_D, 'shell', 'the shell wins over every file');
  assert.deepEqual(envFiles().map((f) => path.basename(f)), ['.env', '.env.local', '.env']);
  assert.equal(path.dirname(envFiles()[1]), path.resolve(path.dirname(envFiles()[0]), '..', '..'), 'the repo files are two levels above the demo');

test('a failed refresh keeps the last board as a dated snapshot, never "live"', async () => {
  let fail = false;
  let calls = 0;
  const mcp = { async callTool(name) {
    calls += 1;
    if (fail) throw new Error('venue wifi');
    return name === 'get_news_intelligence' ? { topStories: [] } : { clusters: [{ id: 'c1', title: 'A', sources: ['BBC'] }] };
  } };
  const live = new CombinedSource(new LiveSource(mcp), null);
  const first = await live.boardClusters();
  assert.equal(first.from, 'live');
  fail = true;
  const after = await live.boardClusters({ force: true });
  assert.equal(after.from, 'last-good', 'the retained board is labelled a snapshot');
  assert.equal(after.asOf, first.asOf, 'it keeps its own time');
  assert.equal(after.clusters.length, first.clusters.length);
  // Concurrent callers share one load: one MCP call per snapshot, not one per caller.
  const shared = new LiveSource({ async callTool() { calls += 1; await new Promise((r) => setTimeout(r, 20)); return { topStories: [] }; } });
  const before = calls;
  await Promise.all([shared.intelligencePayload(), shared.intelligencePayload(), shared.intelligencePayload()]);
  assert.equal(calls - before, 1);
});
