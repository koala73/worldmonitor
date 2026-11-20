import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { createRequire } from 'node:module';
import { ALERT_POOL_MAX_ITEMS, alertPoolItems } from '../server/worldmonitor/news/v1/list-feed-digest';
import { INTEL_SOURCES, VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';

const { buildClassifyCandidateMap } = createRequire(import.meta.url)('../scripts/lib/digest-stale-gate.cjs');

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

it('the digest writes the pool key the relay reads, and a relay from before the language filter reads neither', () => {
  const keyIn = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').match(/`(news:alert-pool:v\d+):\$\{variant\}`/)?.[1];
  assert.equal(keyIn('../server/worldmonitor/news/v1/list-feed-digest.ts'), 'news:alert-pool:v2');
  assert.equal(keyIn('../scripts/ais-relay.cjs'), 'news:alert-pool:v2');
});

it('pools an English Google News query whatever language its feed is routed to', () => {
  // Hankyoreh is routed to Korean digests (lang ko) but queried in English.
  const servable = [item('Supreme Court overturns jail term', 1, { source: 'Hankyoreh', lang: 'ko' })];
  assert.deepEqual(alertPoolItems(servable, [], now, 'en').map(i => i.title), ['Supreme Court overturns jail term']);
});

it('the pool keeps exactly the feeds the relay lets alert, for every feed in the catalog', () => {
  const feeds = [...Object.values(VARIANT_FEEDS).flatMap(byCategory => Object.values(byCategory).flat()), ...INTEL_SOURCES];
  const names = [...new Set(feeds.map(feed => feed.name))];
  const candidates = buildClassifyCandidateMap({ categories: { all: { items: names.map(name => ({ title: name, source: name, publishedAt: now })) } } }, [], 'full', now, 3_600_000);
  const alerting = names.filter(name => !candidates.get(name).otherLanguage);
  // lang 'xx': a catalog feed is decided by the catalog, not by the item.
  const poolKeeps = (name: string) => alertPoolItems([item(name, 1, { source: name, lang: 'xx' })], [], now, 'en').length === 1;
  assert.deepEqual(names.filter(name => alerting.includes(name) !== poolKeeps(name)), []);
  assert.ok(alerting.length > 500 && alerting.length < names.length);
});

it('a served copy that cannot alert does not keep an English copy of the same headline out of the pool', () => {
  const title = 'Ukraine says missiles damaged Kerch Bridge';
  const served = [item(title, 1, { source: 'Hromadske', lang: 'uk' })];
  const servable = [...served, item(title, 2, { source: 'Kyiv Independent' })];
  assert.deepEqual(alertPoolItems(servable, served, now, 'en').map(i => i.source), ['Kyiv Independent']);
});
