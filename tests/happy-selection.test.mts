import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NewsItem } from '../src/types/index.ts';
import { classifyNewsItem } from '../src/services/positive-classifier.ts';
import {
  dedupeHappyItems,
  isBreakthroughStory,
  isHeroStory,
  selectCuratedHappyItems,
} from '../src/services/happy-selection.ts';

const story = (source: string, title: string, link = `https://example.org/${encodeURIComponent(title)}`): NewsItem => ({
  source,
  title,
  link,
  pubDate: new Date(0),
  isAlert: false,
  happyCategory: classifyNewsItem(source, title),
});

test('GNN subfeed copies of one article render once, under the category feed', () => {
  const link = 'https://www.goodnewsnetwork.org/viral-infections-fall-68-in-brazil/';
  const items = dedupeHappyItems([
    story('Good News Network', 'Viral Infections Fall 68% in Brazil', link),
    story('GNN Health', 'Viral Infections Fall 68% in Brazil', `${link}?utm_source=rss`),
    story('GNN Heroes', 'Thanksgiving Heroes'),
  ]);
  assert.deepEqual(items.map(item => [item.source, item.happyCategory]), [
    ['GNN Health', 'science-health'],
    ['GNN Heroes', 'humanity-kindness'],
  ]);
});

test('broad-source items must pass the sentiment gate; dedicated positive outlets do not', async () => {
  const negative = story('Mongabay', 'A grim year for coral reefs across the Pacific');
  const positive = story('Mongabay', 'Rangers record first jaguar cubs in a decade');
  const dedicated = story('Positive.News', 'Town turns its car park into a community orchard');
  const gated: NewsItem[][] = [];
  const result = await selectCuratedHappyItems([negative, positive, dedicated], async (items) => {
    gated.push(items);
    return items.filter(item => item !== negative);
  });
  assert.deepEqual(result, [positive, dedicated]);
  assert.deepEqual(gated, [[negative, positive]]);
});

test('science outlets default to science, and astronomy "solar" is not a climate win', () => {
  assert.equal(classifyNewsItem('ScienceDaily', 'A black hole the size of an atom could destroy an entire star'), 'science-health');
  assert.equal(classifyNewsItem('ScienceDaily', "New nose drops restore youthful memory and fight Alzheimer's in aging mice"), 'science-health');
  assert.equal(classifyNewsItem('New Scientist', 'Uranus is the strangest planet in the solar system'), 'science-health');
  assert.equal(classifyNewsItem('Good News Network', 'Village solar farm cuts power bills in half'), 'climate-wins');
  assert.equal(classifyNewsItem('Upworthy', "Artist shares 5 things he sees 'differently' after the age of 50"), 'humanity-kindness');
});

test('breakthroughs need article-level evidence, not just a science publisher', () => {
  const shown = [
    story('ScienceDaily', "New nose drops restore youthful memory and fight Alzheimer's in aging mice"),
    story('New Scientist', 'An atom-sized black hole could force an entire star to explode'),
  ];
  const hidden = [
    story('Nature News', 'Fight AI slop without punishing legitimate researchers'),
    story('Nature News', "Submission caps aren't enough to tackle AI slop"),
    story('Nature News', 'Richard of Wallingford and his Rectangulus'),
    story('Greater Good (Berkeley)', 'When Your Doctor Prescribes a Visit to an Art Gallery'),
  ];
  assert.deepEqual([...shown, ...hidden].filter(isBreakthroughStory), shown);
});

test("Today's Hero needs a hero story, not the default category", () => {
  assert.equal(isHeroStory(story('Upworthy', "Artist shares 5 things he sees 'differently' after the age of 50")), false);
  assert.equal(isHeroStory(story('GNN Heroes', 'Teen rescues family of five from flooded car')), true);
  assert.equal(isHeroStory(story('Sunny Skyz', 'Strangers pay off school lunch debt for an entire district')), true);
});

test('broad-source negative reporting is screened even when the ML gate passes everything', async () => {
  const titles = [
    'Cargill publicly backs EU deforestation law while lobbying to weaken it, probe finds',
    'Severe drought dries up rivers, cuts off communities in Brazil’s Amazon',
    'Divided and displaced: Brazil’s Kaingang people wait for an end to illegal leasing conflict',
    'Nigeria’s ivory and pangolin trade exposes gaps in wildlife crime prosecutions',
    "Study reveals rising 'double threat' of wildfire smoke and heatwaves in Indonesia",
  ];
  const kept = story('Mongabay', 'Photos: Elephants maintain an essential role in conservation in Nepal despite shifting norms');
  const science = story('New Scientist', 'An atom-sized black hole could force an entire star to explode');
  const recoveries = [
    story('ScienceDaily', 'New treatment reverses hearing loss in mice'),
    story('Mongabay', 'Tiger poaching falls to record low as patrols expand'),
  ];
  const result = await selectCuratedHappyItems([...titles.map(title => story('Mongabay', title)), kept, science, ...recoveries], async items => items);
  assert.deepEqual(result, [kept, science, ...recoveries]);
});
