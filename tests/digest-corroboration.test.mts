/**
 * #9213: every chat and email digest item states the story's corroboration,
 * read from the verdict list-feed-digest stored on the story's track row.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

import { STORY_CORROBORATION_FIELD } from '../server/_shared/label-history';
import {
  attachDigestCorroboration,
  digestCoverageText,
  digestWebhookStory,
  readStoryCorroboration,
  storyCorroborationField,
} from '../scripts/lib/digest-corroboration.mjs';
import { buildDigestDeliveryPlan } from '../scripts/lib/digest-delivery-plan.mjs';
import { formatDigestHtml } from '../scripts/lib/digest-email-html.mjs';
import { stripSourceSuffix } from '../scripts/lib/brief-dedup-jaccard.mjs';
import { escapeDigestText, formatDigestItemTitle } from '../scripts/_digest-markdown.mjs';

const NOW = Date.UTC(2026, 9, 17, 12);

describe('the stored verdict', () => {
  it('is read from the server\'s field for the digest\'s own variant', () => {
    for (const [variant, lang] of [['full', 'en'], ['tech', 'en'], ['full', 'fr']]) {
      assert.equal(storyCorroborationField(variant, lang), STORY_CORROBORATION_FIELD(variant, lang));
    }
    const track = { 'corroboration:full:en': 'corroborated|3', 'corroboration:tech:en': 'single-publisher|1' };
    assert.equal(readStoryCorroboration(track, 'full', 'en'), 'corroborated|3');
    assert.equal(readStoryCorroboration(track, 'tech', 'en'), 'single-publisher|1');
    assert.equal(readStoryCorroboration(track, 'finance', 'en'), '');
    assert.equal(readStoryCorroboration(undefined, 'full', 'en'), '');
  });

  it('is attached to each digest story from the hashes it was merged from', () => {
    const stories = [
      { hash: 'h1', corroboration: 'single-publisher|1' },
      { hash: 'h2', corroboration: 'corroborated|3' },
      { hash: 'h3', corroboration: 'single-publisher|1' },
      { hash: 'h4', corroboration: '' },
    ];
    const reps = [
      { hash: 'h1', mergedHashes: ['h1', 'h2'], sources: ['Reuters World', 'BBC World'] },
      { hash: 'h3', sources: ['Reuters World', 'Reuters Business'] },
      { hash: 'h4', mergedHashes: ['h4'], sources: ['AP News'] },
    ];
    attachDigestCorroboration(reps, stories);
    assert.deepEqual(reps.map((rep) => rep.corroboration), [
      { state: 'corroborated', publishers: 3 },
      { state: 'single-publisher', publishers: 1 },
      null,
    ]);
  });
});

// formatDigest lives in the cron entrypoint, which runs on import; evaluate
// the production function's own text.
const seedSource = readFileSync(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('digest.mjs', seedSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const formatDigestNode = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'formatDigest');
assert.ok(formatDigestNode, 'formatDigest must exist');
const formatDigest = new Function(
  'DIGEST_CRITICAL_LIMIT', 'DIGEST_HIGH_LIMIT', 'DIGEST_MEDIUM_LIMIT', 'stripSourceSuffix', 'digestCoverageText',
  'escapeDigestText', 'formatDigestItemTitle',
  `${formatDigestNode.getText(parsed)}\nreturn formatDigest;`,
)(Infinity, 15, 10, stripSourceSuffix, digestCoverageText, escapeDigestText, formatDigestItemTitle) as (
  stories: unknown[], nowMs: number, target?: string,
) => string;

const story = (corroboration: unknown, title = 'Port strike halts container traffic') => ({
  title, severity: 'high', phase: 'sustained', sources: ['Reuters'], link: 'https://www.reuters.com/x',
  description: '', hash: `c-${title}`, ...(corroboration === undefined ? {} : { corroboration }),
});

describe('an unmerged reprinted story', () => {
  it('keeps the stored single-publisher verdict although its feed labels are two families', () => {
    const reps = [{ hash: 'r1', mergedHashes: ['r1'], sources: ['Reuters World', 'Harbour Gazette'] }];
    attachDigestCorroboration(reps, [{ hash: 'r1', corroboration: 'single-publisher|1' }]);
    assert.deepEqual(reps[0]!.corroboration, { state: 'single-publisher', publishers: 1 });
  });
});

describe('chat digest (formatDigest)', () => {
  it('states the coverage on each item', () => {
    const text = formatDigest([
      story({ state: 'single-publisher', publishers: 1 }),
      story({ state: 'corroborated', publishers: 4 }, 'Ceasefire talks resume'),
      story({ state: 'tier4-only', publishers: 2 }, 'Chip export rumour spreads'),
    ], NOW);
    assert.match(text, /• Port strike halts container traffic \[Reuters\] · Coverage: single publisher$/m);
    assert.match(text, /• Ceasefire talks resume \[Reuters\] · Coverage: 4 independent publishers$/m);
    assert.match(text, /• Chip export rumour spreads \[Reuters\] · Coverage: 2 publishers, all tier 4$/m);
  });

  it('keeps the coverage beside the linked title on chat targets', () => {
    const text = formatDigest([story({ state: 'single-publisher', publishers: 1 })], NOW, 'slack');
    assert.match(text, /• <https:\/\/www\.reuters\.com\/x\|Port strike halts container traffic> \[Reuters\] · Coverage: single publisher$/m);
  });

  it('states nothing for an unknown verdict', () => {
    const text = formatDigest([story(null), story(undefined, 'Second story')], NOW);
    assert.doesNotMatch(text, /Coverage/);
  });
});

describe('email digest (formatDigestHtml)', () => {
  it('states the coverage on each card', () => {
    const html = formatDigestHtml([
      story({ state: 'single-publisher', publishers: 1 }),
      story(null, 'Unknown coverage story'),
    ], NOW)!;
    assert.equal(html.match(/Coverage: single publisher/g)?.length, 1);
    assert.equal(html.match(/Coverage:/g)?.length, 1);
  });
});

describe('delivery plan', () => {
  it('carries each raw story\'s verdict onto the brief-shaped formatter story', () => {
    const plan = buildDigestDeliveryPlan({
      briefStories: [
        { clusterId: 'kept', headline: 'Kept', threatLevel: 'high', source: 'Reuters', sourceUrl: '', description: '' },
        { clusterId: 'unknown', headline: 'Unknown', threatLevel: 'high', source: 'AP', sourceUrl: '', description: '' },
      ],
      rawStories: [
        { mergedHashes: ['kept'], hash: 'kept', sources: ['Reuters'], corroboration: { state: 'corroborated', publishers: 2 } },
        { mergedHashes: ['unknown'], hash: 'unknown', sources: ['AP'], corroboration: null },
      ],
    });
    assert.deepEqual(plan.formatterStories[0]!.corroboration, { state: 'corroborated', publishers: 2 });
    assert.equal('corroboration' in plan.formatterStories[1]!, false);
  });
});

describe('digest webhook', () => {
  it('carries the verdict as a structured field on each story, only when known', () => {
    const known = digestWebhookStory(story({ state: 'single-publisher', publishers: 1 }));
    assert.deepEqual(known, {
      title: 'Port strike halts container traffic', severity: 'high', phase: 'sustained', sources: ['Reuters'],
      corroboration: { state: 'single-publisher', publishers: 1 },
    });
    assert.equal('corroboration' in digestWebhookStory(story(null)), false);
  });
});
