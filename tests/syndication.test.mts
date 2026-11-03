// #9095: same copy under several mastheads counts as one publisher. Fixtures are
// real items from the live digest of 2026-10-11 (title + lead as served).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYNDICATION_MIN_CONTAINMENT,
  copyContainment,
  copyShingles,
  detectSyndication,
} from '../shared/syndication.js';
import { publisherFamilyFor } from '../shared/publisher-families.js';
import { readFileSync } from 'node:fs';

import { clusterNewsCore, clusterPublisherCount } from '../shared/news-clustering-core.js';
import { assignStoryIdentity } from '../server/worldmonitor/news/v1/dedup.mjs';
import { assessCorroboration, evidenceFromCluster, evidenceFromStory, publisherRoster } from '../server/_shared/corroboration.ts';
import { getSourceTier } from '../server/_shared/source-tiers.ts';

const ZAP_TITLE = 'Zaporizhzhia airstrikes kill 17 as Russia intensifies attacks across Ukraine';
const ZAP_LEAD = 'Zaporizhzhia was hit by deadly Russian airstrikes on Saturday, 10 October, killing at least 17 people, including three children, Ukrainian officials said. Rescuers searched rubble for survivors as the city faced renewed strikes on residential areas.';
const RAY_TITLE = 'Pentagon, Raytheon sign $6.3B deal to replenish US missile interceptor supply';
const RAY_LEAD = 'The Pentagon inked a five-year contract with Raytheon for the steady production of ballistic missile interceptors that use force to destroy targets, rather than explosives. The $6.3 billion contract, which provides two additional option years, will see Raytheon produce';

const euronews = { source: 'EuroNews', title: ZAP_TITLE, snippet: ZAP_LEAD };
const africanews = { source: 'Africanews', title: ZAP_TITLE, snippet: ZAP_LEAD };
const militaryTimes = { source: 'Military Times', title: RAY_TITLE, snippet: RAY_LEAD };
// Feeds truncate one lead at different lengths: containment, not equality.
const defenseNews = { source: 'Defense News', title: RAY_TITLE, snippet: `${RAY_LEAD} the SM-6 interceptor at full rate for the Navy.` };

// Independently written reports of one event (same cluster, different copy).
const cbcPanama = {
  source: 'CBC News',
  title: 'Panama declares state of emergency as powerful quake aftershocks rattle communities',
  snippet: 'The government of Panama declared a state of emergency Saturday as the aftershocks of two powerful earthquakes that roiled the country shook communities for hours. Officials did not attribute any deaths to the quakes but reported damages in all 10 of Panama\'s provinces.',
};
const guardianPanama = {
  source: 'Guardian Americas',
  title: '‘It was a terrible thing’: Panama declares state of emergency as quake aftershocks rattle communities',
  snippet: 'More than 100 aftershocks as high as magnitude-5.8 recorded after two quakes toppled buildings and prompted evacuations Panama’s government has declared a state of emergency on Saturday as the aftershocks of two powerful earthquakes',
};
const apFlood = {
  source: 'AP News',
  title: 'Villages evacuated as flash flood from Budhi Gandaki river hits northern Nepal - AP News',
  snippet: 'Villages evacuated as flash flood from Budhi Gandaki river hits northern Nepal &nbsp;&nbsp; AP News',
};
const cbcFlood = {
  source: 'CBC News',
  title: 'Villages evacuated as flash flood from Budhi Gandaki river hits northern Nepal',
  snippet: 'Residents along the Budhi Gandaki river in north central Nepal evacuated on Sunday as flash flooding destroyed homes and other structures in the area.',
};

describe('copy fingerprint', () => {
  it('a headline alone is not a lead: short or title-repeating descriptions do not compare', () => {
    assert.equal(copyShingles({ title: ZAP_TITLE, snippet: 'Short lead.' }), null);
    assert.equal(copyShingles(apFlood), null, 'Google News repeats the headline plus the outlet name');
    assert.ok(copyShingles(euronews));
  });

  it('identical and truncated copy contain each other; independent reports do not', () => {
    assert.equal(copyContainment(copyShingles(euronews)!, copyShingles(africanews)!), 1);
    assert.ok(copyContainment(copyShingles(militaryTimes)!, copyShingles(defenseNews)!) >= SYNDICATION_MIN_CONTAINMENT);
    assert.ok(copyContainment(copyShingles(cbcPanama)!, copyShingles(guardianPanama)!) < SYNDICATION_MIN_CONTAINMENT);
  });

  // Written for this test in the shape of a shared agency copy; not digest items.
  it('compares copy in non-Latin scripts that separate words with spaces', () => {
    const title = 'Взрывы прогремели в Запорожье после ночной атаки беспилотников';
    const lead = 'Серия взрывов прогремела в Запорожье в ночь на воскресенье, сообщили местные власти. По предварительным данным, повреждены жилые дома и объекты энергетики, на месте работают спасатели и пожарные расчёты.';
    const a = copyShingles({ title, snippet: lead });
    const b = copyShingles({ title, snippet: `${lead} Информация о пострадавших уточняется.` });
    assert.ok(a && b);
    assert.ok(copyContainment(a, b) >= SYNDICATION_MIN_CONTAINMENT);
    const greek = copyShingles({
      title: 'Σεισμός 5,2 Ρίχτερ στην Κρήτη',
      snippet: 'Σεισμική δόνηση μεγέθους 5,2 βαθμών της κλίμακας Ρίχτερ σημειώθηκε το πρωί της Κυριακής νότια του Ηρακλείου, σύμφωνα με το Γεωδυναμικό Ινστιτούτο, χωρίς αναφορές για ζημιές.',
    });
    assert.ok(greek, 'Greek leads are long enough to compare');
  });

  it('scripts written without spaces never compare, so they never merge', () => {
    const title = '台风登陆浙江沿海地区';
    const lead = '第十八号台风于周日凌晨在浙江沿海登陆，中心附近最大风力达到十四级，当地已紧急转移数万名群众，多条高铁线路暂停运营，部分航班取消。';
    assert.equal(copyShingles({ title, snippet: lead }), null);
  });

  it('reads a parsed feed item\'s description when there is no snippet', () => {
    const parsed = { source: 'EuroNews', title: ZAP_TITLE, description: ZAP_LEAD };
    assert.deepEqual(copyShingles(parsed), copyShingles(euronews));
  });
});

describe('detectSyndication', () => {
  const byLabel = (item: { source: string }) => publisherFamilyFor(item.source);

  it('same copy under two unlisted mastheads counts once, and the group is listed for review', () => {
    const result = detectSyndication([euronews, africanews], byLabel);
    assert.equal(result.publishers, 1);
    assert.deepEqual(result.groups, [{ families: ['label:africanews', 'label:euronews'], labels: ['EuroNews', 'Africanews'] }]);
    assert.equal(result.familyOf(euronews), result.familyOf(africanews));
  });

  it('independently written reports of one event are not merged', () => {
    for (const pair of [[cbcPanama, guardianPanama], [apFlood, cbcFlood]]) {
      const result = detectSyndication(pair, byLabel);
      assert.equal(result.publishers, 2, pair.map((item) => item.source).join(' + '));
      assert.deepEqual(result.groups, []);
    }
  });

  it('identical headlines without a real lead are not merged', () => {
    const a = { source: 'Outlet One', title: ZAP_TITLE, snippet: '' };
    const b = { source: 'Outlet Two', title: ZAP_TITLE, snippet: `${ZAP_TITLE} Outlet Two` };
    assert.equal(detectSyndication([a, b], byLabel).publishers, 2);
  });

  it('never merges two curated families, even with identical copy', () => {
    const reuters = { source: 'Reuters World', title: ZAP_TITLE, snippet: ZAP_LEAD };
    const bbc = { source: 'BBC World', title: ZAP_TITLE, snippet: ZAP_LEAD };
    assert.notEqual(publisherFamilyFor('Reuters World'), publisherFamilyFor('BBC World'));
    assert.ok(!publisherFamilyFor('BBC World').startsWith('label:'));
    const result = detectSyndication([reuters, bbc], byLabel);
    assert.equal(result.publishers, 2);
    assert.deepEqual(result.groups, []);
  });

  it('an unlisted reprint joins the curated publisher it copied, named after it', () => {
    const reuters = { source: 'Reuters World', title: ZAP_TITLE, snippet: ZAP_LEAD };
    const reprint = { source: 'Small Town Gazette', title: ZAP_TITLE, snippet: ZAP_LEAD };
    const bbc = { source: 'BBC World', title: ZAP_TITLE, snippet: ZAP_LEAD };
    const result = detectSyndication([reuters, reprint, bbc], byLabel);
    assert.equal(result.publishers, 2, 'the reprint joins one curated family; the two curated families stay apart');
    assert.equal(result.familyOf(reprint), publisherFamilyFor('Reuters World'));
  });

  it('the roster names a reprint group after the curated publisher it copied', () => {
    const at = new Date('2026-10-11T09:00:00Z');
    const allItems = [
      { source: 'Small Town Gazette', title: ZAP_TITLE, snippet: ZAP_LEAD, link: 'https://example.test/a', pubDate: at, isAlert: false },
      { source: 'Reuters World', title: ZAP_TITLE, snippet: ZAP_LEAD, link: 'https://example.test/b', pubDate: at, isAlert: false },
    ];
    const roster = publisherRoster(evidenceFromCluster({ allItems }));
    assert.equal(roster.length, 1);
    assert.equal(roster[0]!.family, publisherFamilyFor('Reuters World'));
    assert.equal(roster[0]!.name, 'Reuters');
    assert.equal(roster[0]!.sameCopy, true);
  });

  it('the roster names an unlisted same-copy group after the outlet whose tier it shows', () => {
    // EuroNews is tier 2, Balkan Insight tier 1: the row must not read "EuroNews T1".
    const at = new Date('2026-10-11T09:00:00Z');
    const euro = { source: 'EuroNews', title: ZAP_TITLE, snippet: ZAP_LEAD, link: 'https://example.test/a', pubDate: at, isAlert: false };
    const balkan = { ...euro, source: 'Balkan Insight', link: 'https://example.test/b' };
    for (const allItems of [[euro, balkan], [balkan, euro]]) {
      const roster = publisherRoster(evidenceFromCluster({ allItems }));
      assert.equal(roster.length, 1);
      assert.deepEqual([roster[0]!.name, roster[0]!.tier], ['Balkan Insight', 1], allItems.map((item) => item.source).join(' + '));
    }
  });

  it('one family carrying two different copies does not join the outlets it copied', () => {
    // A hub that reprints both reports is not evidence that the two reporters are one copy.
    const alpha = { source: 'Outlet Alpha', title: cbcPanama.title, snippet: cbcPanama.snippet };
    const beta = { source: 'Outlet Beta', title: guardianPanama.title, snippet: guardianPanama.snippet };
    const hubAlpha = { ...alpha, source: 'Hub Wire' };
    const hubBeta = { ...beta, source: 'Hub Wire' };
    for (const items of [[alpha, beta, hubAlpha, hubBeta], [hubBeta, alpha, hubAlpha, beta]]) {
      const result = detectSyndication(items, byLabel);
      assert.equal(result.publishers, 3);
      assert.deepEqual(result.groups, []);
    }
  });

  it('the count can only go down', () => {
    const pool = [euronews, africanews, militaryTimes, defenseNews, cbcPanama, guardianPanama, apFlood, cbcFlood,
      { source: 'Reuters World', title: ZAP_TITLE, snippet: ZAP_LEAD }, { source: 'BBC World', title: ZAP_TITLE, snippet: ZAP_LEAD }];
    for (let mask = 1; mask < 1 << pool.length; mask += 37) {
      const subset = pool.filter((_, i) => mask & (1 << i));
      const families = new Set(subset.map(byLabel)).size;
      const { publishers } = detectSyndication(subset, byLabel);
      assert.ok(publishers <= families && publishers >= 1, `${publishers} vs ${families}`);
    }
  });
});

describe('every surface that counts publishers applies it', () => {
  const at = new Date('2026-10-11T09:00:00Z');
  const asNewsItems = (items: typeof euronews[]) => items.map((item, i) => ({ ...item, link: `https://example.test/${i}`, pubDate: at, isAlert: false }));

  it('server story identity: corroborationCount counts the copy once', async () => {
    const items = [
      { source: 'EuroNews', title: ZAP_TITLE, description: ZAP_LEAD, publishedAt: at.getTime() },
      { source: 'Africanews', title: ZAP_TITLE, description: ZAP_LEAD, publishedAt: at.getTime() },
    ];
    const identities = await assignStoryIdentity(items, (t) => t.toLowerCase(), async (t) => `h:${t}`);
    for (const item of items) assert.equal(identities.get(item)?.corroborationCount, 1);
  });

  it('clusterNewsCore: uniquePublisherCount counts the copy once', () => {
    const [cluster] = clusterNewsCore(asNewsItems([euronews, africanews]), getSourceTier);
    assert.equal(cluster!.allItems.length, 2);
    assert.equal(cluster!.uniquePublisherCount, 1);
  });

  it('the dashboard\'s semantic merge rebuilds the count with the same detector', () => {
    assert.equal(clusterPublisherCount(asNewsItems([euronews, africanews, cbcPanama])), 2);
    const source = readFileSync(new URL('../src/services/clustering.ts', import.meta.url), 'utf8');
    assert.match(source, /uniquePublisherCount: clusterPublisherCount\(allItems\)/);
    assert.doesNotMatch(source, /countPublisherFamilies/);
  });

  it('evidenceFromCluster, verdict and roster: one publisher, shown as the same copy', () => {
    const evidence = evidenceFromCluster({ allItems: asNewsItems([euronews, africanews]) });
    assert.deepEqual(assessCorroboration(evidence), { state: 'single-publisher', publishers: 1 });
    const roster = publisherRoster(evidence);
    assert.equal(roster.length, 1);
    assert.deepEqual(roster[0]!.labels, ['EuroNews', 'Africanews']);
    assert.equal(roster[0]!.sameCopy, true);
  });

  it('insights and brief leads: the lead survives normalization and the story carries the same copy', async () => {
    const { normalizeDigestItemsForInsights } = await import('../scripts/seed-insights.mjs');
    const { clusterItems, isBriefLeadEligible } = await import('../scripts/_clustering.mjs');
    const digestItems = [euronews, africanews].map((item) => ({ ...item, link: `https://example.test/${item.source}`, publishedAt: at.getTime() }));
    const [cluster, ...rest] = clusterItems(normalizeDigestItemsForInsights(digestItems));
    assert.equal(rest.length, 0);
    assert.equal(cluster.uniquePublisherCount, 1);
    assert.equal(isBriefLeadEligible(cluster), false);

    // The published story keeps both labels; its groups make every reader count them once.
    const story = { sources: cluster.sources, corroborationCount: 1, sameCopy: cluster.sameCopy };
    assert.deepEqual(assessCorroboration(evidenceFromStory(story)), { state: 'single-publisher', publishers: 1 });
    assert.deepEqual(publisherRoster(evidenceFromStory(story)).map((p) => [p.labels, p.sameCopy]), [[['EuroNews', 'Africanews'], true]]);
    const seeder = readFileSync(new URL('../scripts/seed-insights.mjs', import.meta.url), 'utf8');
    assert.match(seeder, /\{ sameCopy: story\.sameCopy \}/);
  });

  it('a story\'s same-copy groups can only join families its own labels name', () => {
    const story = (sameCopy: unknown) => evidenceFromStory({ sources: ['EuroNews', 'Africanews'], corroborationCount: 1, sameCopy });
    const euro = publisherFamilyFor('EuroNews');
    const africa = publisherFamilyFor('Africanews');
    // A group naming an absent family, a lone family, or junk is dropped: the count stays 2.
    for (const junk of [[[euro, publisherFamilyFor('Balkan Insight')]], [[euro]], 'x', [[1, 2]], [null]]) {
      assert.deepEqual(assessCorroboration(story(junk)), { state: 'corroborated', publishers: 2 }, JSON.stringify(junk));
    }
    assert.deepEqual(assessCorroboration(story([[euro, africa]])), { state: 'single-publisher', publishers: 1 });
  });

  it('independent reports still corroborate, with no same-copy marker', () => {
    const evidence = evidenceFromCluster({ allItems: asNewsItems([cbcPanama, guardianPanama]) });
    assert.deepEqual(assessCorroboration(evidence), { state: 'corroborated', publishers: 2 });
    assert.ok(publisherRoster(evidence).every((publisher) => publisher.sameCopy === undefined));
    assert.equal('sameCopy' in evidence, false);
  });
});
