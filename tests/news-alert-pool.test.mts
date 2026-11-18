import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ALERT_POOL_MAX_ITEMS, alertPoolItems } from '../server/worldmonitor/news/v1/list-feed-digest';

const now = Date.now();
const item = (title: string, ageMin: number, extra: Record<string, unknown> = {}) => ({
  title, source: 'Al Arabiya', link: `https://english.alarabiya.net/${encodeURIComponent(title)}`,
  publishedAt: now - ageMin * 60_000, corroborationCount: 1, ...extra,
}) as never;

it('pools fresh items the category cap kept off the dashboard, newest first, once per title (#10978)', () => {
  const served = [item('served', 1)];
  const servable = [item('served', 1), item('older', 30), item('newer', 5, { linkVerified: true }), item('newer', 6), item('stale', 7 * 60)];
  assert.deepEqual(alertPoolItems(servable, served, now).map(i => [i.title, i.linkVerified === true]), [['newer', true], ['older', false]]);
});

it('bounds the pool', () => {
  const servable = Array.from({ length: ALERT_POOL_MAX_ITEMS + 50 }, (_, i) => item(`t${i}`, i % 300));
  assert.equal(alertPoolItems(servable, [], now).length, ALERT_POOL_MAX_ITEMS);
});
