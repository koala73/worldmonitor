import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseShfeNotices, fetchShfeNotices, SHFE_NOTICES_URL } from '../scripts/china-futures/shfe-notices.mjs';

const now = Date.parse('2026-10-19T12:00:00+08:00');
const fixture = readFileSync(new URL('./fixtures/china-futures/shfe-notices.html', import.meta.url), 'utf8');
function row({ day = '2026-10-16', href = './202610/t20261016_900001.html', title = '关于铜&amp;铝仓库的公告' } = {}) {
  return `<div class="table_item_info"><div class="info_item_title"><a href="${href}" title="${title}">${title}</a></div><div class="info_item_date">${day}</div></div>`;
}

test('parses the captured official listing with day precision and stable identity', () => {
  const items = parseShfeNotices(fixture, now);
  assert.equal(items.length, 1);
  assert.match(items[0].title, /中化兴中石油/);
  assert.equal(items[0].publicationDate, '2026-10-19');
  assert.equal(items[0].publishedAt, '2026-10-18T16:00:00.000Z');
  assert.equal(items[0].datePrecision, 'day');
  assert.equal(items[0].sourceId, 'cn-shfe-notices');
  assert.match(items[0].sourceUrl, /^https:\/\/www\.shfe\.com\.cn\/publicnotice\/notice\/202610\/t20261019_\d+\.html$/);
  assert.deepEqual(items, parseShfeNotices(fixture, now + 86_400_000));
});

test('decodes once, deduplicates canonical links, and retains content revisions', () => {
  const original = parseShfeNotices(row() + row(), now);
  assert.equal(original.length, 1);
  assert.equal(original[0].title, '关于铜&铝仓库的公告');
  const revised = parseShfeNotices(row({ title: '关于铜仓库的更正公告' }), now)[0];
  assert.equal(revised.documentId, original[0].documentId);
  assert.notEqual(revised.revision, original[0].revision);
  assert.equal(parseShfeNotices(row({ title: '铜&amp;lt;公告' }), now)[0].title, '铜&lt;公告');
});

test('rejects non-official links, invalid dates, mismatched path dates and script content', () => {
  for (const href of ['https://evil.test/publicnotice/notice/202610/t20261016_1.html', 'javascript:alert(1)', 'https://www.shfe.com.cn@evil.test/a', './202610/t20261015_1.html', '/news/202610/t20261016_1.html']) {
    assert.deepEqual(parseShfeNotices(row({ href }), now), [], href);
  }
  for (const day of ['2026-02-30', '2026-10-20', '', '2026-10-16T09:00']) {
    assert.deepEqual(parseShfeNotices(row({ day }), now), [], day);
  }
  assert.deepEqual(parseShfeNotices(`<script>${row()}</script><!--${row()}-->`, now), []);
  assert.deepEqual(parseShfeNotices(row().replace('href=', 'data-href='), now), []);
});

test('fetches only the official listing and reports empty or malformed responses as failures', async () => {
  const snapshot = await fetchShfeNotices({ now, fetchImpl: async (url, options) => {
    assert.equal(url, SHFE_NOTICES_URL);
    assert.equal(options.redirect, 'error');
    assert.ok(options.headers['User-Agent']);
    assert.ok(options.signal);
    return new Response(fixture, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } });
  assert.equal(snapshot.fetchedAt, now);
  assert.equal(snapshot.items.length, 1);
  for (const response of [new Response('blocked', { status: 403 }), new Response('<html>verification</html>', { headers: { 'Content-Type': 'text/html' } }), new Response('{}', { headers: { 'Content-Type': 'application/json' } })]) {
    await assert.rejects(fetchShfeNotices({ now, fetchImpl: async () => response }));
  }
});

test('bounds streamed responses even when content-length is absent', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_000_001)); controller.close(); } });
  await assert.rejects(fetchShfeNotices({ now, fetchImpl: async () => new Response(body, { headers: { 'Content-Type': 'text/html' } }) }), /size limit/);
});

test('passes provider retry policy to runSeed without shortening Retry-After', async () => {
  for (const [status, retryAfter, nonRetryable, retryAfterMs] of [
    [403, null, true, undefined],
    [429, '2', false, 2000],
    [429, '1200', true, 1_200_000],
    [503, '30', true, 30_000],
  ]) {
    const headers = retryAfter ? { 'Retry-After': retryAfter } : {};
    await assert.rejects(fetchShfeNotices({ fetchImpl: async () => new Response('unavailable', { status, headers }) }), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.nonRetryable, nonRetryable);
      assert.equal(error.retryAfterMs, retryAfterMs);
      return true;
    });
  }
});
