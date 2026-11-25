import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildArticlePrompts } from '../server/worldmonitor/news/v1/_shared.ts';
import { describesHeadlines } from '../server/worldmonitor/news/v1/summarize-article.ts';
import { buildSummaryCacheKey } from '../src/utils/summary-cache-key.ts';

const title = "Artist shares 5 things he sees 'differently' after the age of 50";
const body = 'A painter reflects on patience, curiosity and slowing down as he passed 50.';

test('article mode grounds one story on its own context, without geopolitical framing', () => {
  const { systemPrompt, userPrompt } = buildArticlePrompts([title], [title], {
    mode: 'article', geoContext: '', variant: 'happy', lang: 'en', bodies: [body],
  });
  assert.equal(userPrompt, `1. ${title}\n    Context: ${body}`);
  assert.doesNotMatch(systemPrompt, /geopolitical|Pick the/i);
  assert.match(systemPrompt, /ONLY facts stated in the headline and its Context/);
});

test('headline commentary is rejected as a summary', () => {
  assert.equal(describesHeadlines('The most important headline is about a study or survey finding that women universally value a specific non-physical trait in men as the most attractive.'), true);
  assert.equal(describesHeadlines('This headline describes an artist reflecting on aging.'), true);
  assert.equal(describesHeadlines('A painter says turning 50 taught him patience and curiosity, and he now slows down to notice small details.'), false);
  assert.equal(describesHeadlines('The Guardian corrected the headline after readers said it misnamed the town.'), false);
  assert.equal(describesHeadlines('The headline inflation rate fell to 2% as energy costs declined.'), false);
  assert.equal(describesHeadlines('These two headlines report on a new vaccine.'), true);
  assert.equal(describesHeadlines('The U.S. and Ukraine announced a partial ceasefire agreement, halting strikes on energy infrastructure.'), false);
});

test('article summaries do not share cache rows with multi-headline briefs', async () => {
  const article = await buildSummaryCacheKey([title], 'article', '', 'happy', 'en', undefined, [body]);
  const brief = await buildSummaryCacheKey([title, 'Upworthy'], 'brief', '', 'happy', 'en');
  assert.match(article, /^summary:v13:article:happy:en:/);
  assert.notEqual(article, brief);
});
