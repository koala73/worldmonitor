import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import xPostBudget from '../scripts/lib/x-post-budget.cjs';
import { parseJapanXPosts, fetchJapanXOutcome, JAPAN_X_ACCOUNT_ID, JAPAN_X_POLL_MS } from '../scripts/cross-strait-activity/japan-x.mjs';
import { fetchCrossStraitActivitySnapshot, buildCrossStraitActivitySnapshot, parseTaiwanMndDetail, validateCrossStraitActivitySnapshot } from '../scripts/cross-strait-activity/adapters.mjs';
import { isCrossStraitActivitySnapshot } from '../src/components/cross-strait-activity-summary.ts';
import { projectCrossStraitActivityBootstrap } from '../scripts/seed-cross-strait-activity.mjs';

const now = Date.parse('2026-10-24T12:00:00Z');
const payload = () => ({
  data: [{ id: '2112200180078645347', author_id: JAPAN_X_ACCOUNT_ID,
    created_at: '2026-10-23T16:00:00Z', text: 'Short aircraft report',
    note_tweet: { text: 'BZK-005 × 1\nY-9 × 1\nTB-001 × 1' },
    attachments: { media_keys: ['3_map'] } }],
  includes: { media: [{ media_key: '3_map', type: 'photo', url: 'https://pbs.twimg.com/media/map.png' }] },
  meta: { result_count: 1 },
});
function budget() {
  let calls = 0;
  return xPostBudget.createXPostBudget({ now: () => now, idFactory: () => 'japan-test',
    evalCommand: async () => ++calls % 2 === 1 ? [1, 50, 50, 0, 0] : [1, 1, 1, 50, 1, 0] });
}
const fetchOutcome = (options = {}) => fetchJapanXOutcome({ token: 'test-only', now,
  budget: budget(), fetchFn: async () => Response.json(payload()), ...options });

test('keeps full text and official photo evidence as review candidates using Japan publication day', () => {
  const [candidate] = parseJapanXPosts(payload());
  assert.equal(candidate.text, payload().data[0].note_tweet.text);
  assert.equal(candidate.publicationDay, '2026-10-24');
  assert.equal(candidate.sourceUrl, 'https://x.com/jointstaffpa/status/2112200180078645347');
  assert.deepEqual(candidate.images, [{ url: 'https://pbs.twimg.com/media/map.png' }]);
  assert.equal(candidate.admission, 'manual_review_required');
});

test('rejects partial results, wrong authors, missing media and unsafe image URLs', () => {
  for (const mutate of [
    b => { b.meta.next_token = 'more'; }, b => { b.errors = [{ detail: 'partial' }]; },
    b => { b.meta.result_count = 2; }, b => { b.data[0].author_id = 'other'; },
    b => { b.includes.media = []; }, b => { b.includes.media[0].url = 'https://other.example/map.png'; },
  ]) {
    const body = payload(); mutate(body);
    assert.throws(() => parseJapanXPosts(body), /JMOD_X_/);
  }
});

test('requests a bounded full-text media timeline with budget admission and refreshes existing candidates', async () => {
  const old = { ...parseJapanXPosts(payload())[0], text: 'old' };
  const outcome = await fetchOutcome({ previousSource: { candidates: [old] }, fetchFn: async (input, init) => {
    const url = new URL(input);
    assert.equal(url.pathname, `/2/users/${JAPAN_X_ACCOUNT_ID}/tweets`);
    assert.equal(url.searchParams.get('max_results'), '25');
    assert.equal(url.searchParams.get('start_time'), '2026-10-21T12:00:00.000Z');
    assert.match(url.searchParams.get('tweet.fields'), /note_tweet/);
    assert.equal(url.searchParams.get('expansions'), 'attachments.media_keys');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer test-only');
    return Response.json(payload());
  } });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.requestCount, 1);
  assert.equal(outcome.candidates.length, 1);
  assert.equal(outcome.candidates[0].text, payload().data[0].note_tweet.text);
});

test('cache avoids another request and preserves acquisition time through snapshot and public projection', async () => {
  const first = await fetchOutcome();
  const snapshot = buildCrossStraitActivitySnapshot({ generatedAt: new Date(now).toISOString(),
    mndOutcome: { ok: false, observations: [] }, japanOutcome: first });
  const source = snapshot.sources.find(s => s.id === 'japan-mod');
  const cached = await fetchOutcome({ now: now + 3600000, previousSource: source,
    fetchFn: () => assert.fail('cache must not fetch') });
  const next = buildCrossStraitActivitySnapshot({ generatedAt: new Date(now + 3600000).toISOString(),
    previousSnapshot: snapshot, mndOutcome: { ok: false, observations: [] }, japanOutcome: cached });
  const nextSource = next.sources.find(s => s.id === 'japan-mod');
  assert.equal(nextSource.lastSuccessAt, source.lastSuccessAt);
  assert.equal(nextSource.requestCount, 0);
  assert.equal(nextSource.admittedDocumentCount, 2);
  assert.equal(next.observations.filter(row => row.sourceId === 'japan-mod').length, 2);
  const publicSource = projectCrossStraitActivityBootstrap(next).sources.find(s => s.id === 'japan-mod');
  assert.equal(publicSource.candidates, undefined);
  assert.equal(publicSource.xDiscovery, undefined);
});

test('failure preserves previous candidates and acquisition time; failed checks also wait six hours', async () => {
  const previousSource = { candidates: parseJapanXPosts(payload()), lastSuccessAt: '2026-10-23T12:00:00.000Z' };
  const failed = await fetchOutcome({ previousSource, fetchFn: async () => Response.json({ title: 'Unauthorized' }, { status: 401 }) });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.errorCodes, ['JMOD_X_HTTP_401']);
  assert.equal(failed.acquiredAt, previousSource.lastSuccessAt);
  assert.deepEqual(failed.candidates, previousSource.candidates);
  const cached = await fetchOutcome({ previousSource: { ...previousSource, xDiscovery: failed.xDiscovery },
    now: now + JAPAN_X_POLL_MS - 1, fetchFn: () => assert.fail('failure cooldown must not fetch') });
  assert.equal(cached.ok, false);
  assert.equal(cached.requestCount, 0);
});

test('valid empty recent window succeeds but pagination and API partial errors fail', async () => {
  const empty = await fetchOutcome({ fetchFn: async () => Response.json({ meta: { result_count: 0 } }) });
  assert.equal(empty.ok, true);
  assert.equal(empty.xDiscovery.postCount, 0);
  const partial = payload(); partial.meta.next_token = 'more';
  const failed = await fetchOutcome({ fetchFn: async () => Response.json(partial) });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.errorCodes, ['JMOD_X_COVERAGE_PARTIAL']);
});

test('budget denial and failed settlement cannot publish success', async () => {
  const denied = await fetchOutcome({ budget: xPostBudget.createXPostBudget({ evalCommand: async () => null }),
    fetchFn: () => assert.fail('budget denial must not fetch') });
  assert.equal(denied.ok, false);
  assert.equal(denied.requestCount, 0);
  assert.deepEqual(denied.errorCodes, ['JMOD_X_BUDGET_UNAVAILABLE']);
  let calls = 0;
  const unsettled = await fetchOutcome({ budget: xPostBudget.createXPostBudget({
    evalCommand: async () => ++calls === 1 ? [1, 50, 50, 0, 0] : null }) });
  assert.equal(unsettled.ok, false);
  assert.deepEqual(unsettled.errorCodes, ['JMOD_X_BUDGET_UNSETTLED']);
});

test('configured X source skips MOD indices and PDFs and admits no unreviewed observations', async () => {
  const requests = [];
  const snapshot = await fetchCrossStraitActivitySnapshot({ now, japanXToken: 'test-only', japanXBudget: budget(),
    mndListUrl: 'https://invalid.example/list', proxyUrl: '', mndProxyUrl: '', sleepFn: async () => {},
    fetchFn: async input => { requests.push(String(input)); return Response.json(payload()); } });
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]).hostname, 'api.x.com');
  const source = snapshot.sources.find(s => s.id === 'japan-mod');
  assert.equal(source.transportStatus, 'fresh');
  assert.equal(source.transportPath, 'x_api');
  assert.equal(source.candidates[0].images.length, 1);
  assert.equal(source.admittedDocumentCount, 2);
});

test('captured official aircraft post retains all three types and four images', () => {
  const body = JSON.parse(readFileSync(new URL('./fixtures/cross-strait-activity/jmod-x-aircraft.json', import.meta.url), 'utf8'));
  const [candidate] = parseJapanXPosts(body);
  assert.notEqual(candidate.text, body.data[0].text);
  for (const type of ['ＢＺＫ－００５', 'Ｙ－９', 'ＴＢ－００１']) assert.ok(candidate.text.includes(type));
  assert.equal(candidate.images.length, 4);
});

test('expired cache fetches once, bounds the candidate queue, and rejects oversized responses', async () => {
  const previousSource = { lastSuccessAt: '2026-10-23T12:00:00.000Z',
    xDiscovery: { checkedAt: new Date(now - JAPAN_X_POLL_MS).toISOString(), ok: true },
    candidates: [{ sourceUrl: 'https://x.com/jointstaffpa/status/1', publicationDay: '2026-10-22' }] };
  const refreshed = await fetchOutcome({ previousSource, maxCandidates: 1 });
  assert.equal(refreshed.requestCount, 1);
  assert.equal(refreshed.candidates.length, 1);
  assert.equal(refreshed.acquiredAt, new Date(now).toISOString());
  const oversized = await fetchOutcome({ fetchFn: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  assert.equal(oversized.ok, false);
  assert.deepEqual(oversized.errorCodes, ['JMOD_X_RESPONSE_TOO_LARGE']);
});

function publishableSnapshot(japanOutcome, previousSnapshot = null) {
  const observation = parseTaiwanMndDetail(readFileSync(new URL('./fixtures/cross-strait-activity/mnd-detail.html', import.meta.url), 'utf8'), {
    sourceUrl: 'https://www.mnd.gov.tw/en/News/PLAAct/87151',
    retrievedAt: new Date(now).toISOString(), expectedPublicationDay: '2026-07-25',
  });
  return buildCrossStraitActivitySnapshot({ generatedAt: new Date(now).toISOString(), previousSnapshot,
    mndOutcome: { ok: true, observations: [observation] }, japanOutcome });
}

test('projected X snapshot passes the browser contract and preserves reviewed MOD evidence', async () => {
  const previous = publishableSnapshot({ ok: false });
  assert.equal(isCrossStraitActivitySnapshot(projectCrossStraitActivityBootstrap(previous)), true);
  for (const row of previous.observations.filter(row => row.sourceId === 'japan-mod')) {
    row.indexPresence = 'present';
    row.indexCoverage = 'covered_by_current_index';
  }
  const snapshot = publishableSnapshot(await fetchOutcome(), previous);
  assert.equal(isCrossStraitActivitySnapshot(projectCrossStraitActivityBootstrap(snapshot)), true);
  for (const row of snapshot.observations.filter(row => row.sourceId === 'japan-mod')) {
    assert.equal(row.indexPresence, 'present');
    assert.equal(row.indexCoverage, 'covered_by_current_index');
  }
  const cold = publishableSnapshot(await fetchOutcome());
  assert.ok(cold.observations.filter(row => row.sourceId === 'japan-mod').every(row => row.indexPresence === 'unknown'));
});

test('publication accepts bounded X text without loosening unrelated strings or total size', async () => {
  const body = payload(); body.data[0].note_tweet.text = 'あ'.repeat(16000);
  const snapshot = publishableSnapshot(await fetchOutcome({ fetchFn: async () => Response.json(body) }));
  assert.equal(validateCrossStraitActivitySnapshot(snapshot), true);
  const source = snapshot.sources.find(row => row.id === 'japan-mod');
  source.candidates[0].text += 'x';
  assert.equal(validateCrossStraitActivitySnapshot(snapshot), false);
  source.candidates[0].text = 'short'; source.candidates[0].title = 'x'.repeat(2049);
  assert.equal(validateCrossStraitActivitySnapshot(snapshot), false);
  source.candidates[0].title = 'short';
  source.candidates[0].text = 'x'.repeat(2049);
  source.candidates[0].sourceUrl = 'https://example.com/not-official';
  assert.equal(validateCrossStraitActivitySnapshot(snapshot), false);
  source.candidates[0].text = 'short'; snapshot.extra = Array(5000).fill('x'.repeat(1024));
  assert.equal(validateCrossStraitActivitySnapshot(snapshot), false);
});

test('integrated X discovery retains the newest 15 candidates', async () => {
  const body = payload(); body.data = Array.from({ length: 16 }, (_, index) => ({ ...body.data[0], id: String(100 + index),
    created_at: new Date(now - (index + 1) * 60000).toISOString() })); body.meta.result_count = 16;
  const snapshot = await fetchCrossStraitActivitySnapshot({ now, japanXToken: 'test-only', japanXBudget: budget(),
    mndListUrl: 'https://invalid.example/list', proxyUrl: '', mndProxyUrl: '', sleepFn: async () => {},
    fetchFn: async () => Response.json(body) });
  const source = snapshot.sources.find(row => row.id === 'japan-mod');
  assert.equal(source.candidates.length, 15);
  assert.equal(source.candidates.at(-1).documentId, 'x-114');
});
