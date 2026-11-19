import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ALERT_POOL_MAX_ITEMS, alertPoolItems } from '../server/worldmonitor/news/v1/list-feed-digest';

const now = Date.now();
const item = (title: string, ageMin: number, extra: Record<string, unknown> = {}) => ({
  title, source: 'Al Arabiya', link: `https://english.alarabiya.net/${encodeURIComponent(title)}`,
  publishedAt: now - ageMin * 60_000, corroborationCount: 1, lang: 'en', ...extra,
}) as never;

it('pools fresh items the category cap kept off the dashboard, newest first, once per title (#10978)', () => {
  const served = [item('served', 1)];
  const servable = [item('served', 1), item('older', 30), item('newer', 5, { linkVerified: true }), item('newer', 6), item('stale', 7 * 60)];
  assert.deepEqual(alertPoolItems(servable, served, now, 'en').map(i => [i.title, i.linkVerified === true]), [['newer', true], ['older', false]]);
});

it('bounds the pool', () => {
  const servable = Array.from({ length: ALERT_POOL_MAX_ITEMS + 50 }, (_, i) => item(`t${i}`, i % 300));
  assert.equal(alertPoolItems(servable, [], now, 'en').length, ALERT_POOL_MAX_ITEMS);
});

it('keeps the original publisher a topic feed carries, so the relay scores on its tier (#10977)', () => {
  const topic = item('topic', 1, { source: 'Strategic Chokepoints', originPublisher: 'Reuters', originPublisherTrusted: true });
  const untrusted = item('untrusted', 2, { source: 'Strategic Chokepoints', originPublisher: 'Reuters', originPublisherTrusted: false });
  assert.deepEqual(alertPoolItems([topic, untrusted], [], now, 'en').map(i => [i.title, (i as { originPublisher?: string }).originPublisher]), [['topic', 'Reuters'], ['untrusted', undefined]]);
});

it('pools only headlines in the digest language, so local-language outlets cannot alert an English edition', () => {
  const servable = [item('Trump, Xi and Putin end summit', 1), item('Baigėsi Trumpo, Putino, Xi Jinpingo susitikimas', 2, { source: '15min.lt', lang: 'lt' })];
  assert.deepEqual(alertPoolItems(servable, [], now, 'en').map(i => i.title), ['Trump, Xi and Putin end summit']);
});
