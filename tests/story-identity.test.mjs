// shared/story-identity.js — the single "same news story?" definition
// (#4919). The labeled pair set below is the tuning ground truth for
// STORY_SIMILARITY_THRESHOLD: if you change the vectorizer, weights, or
// threshold, this suite tells you whether separation still holds.

import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  STORY_SIMILARITY_THRESHOLD,
  normalizeStoryText,
  stripAttributionSuffix,
  candidateTokens,
  storyVector,
  cosineSimilarity,
  storySimilarity,
  isSameStory,
  clusterTexts,
  setStoryVectorProvider,
} from '../shared/story-identity.js';

afterEach(() => setStoryVectorProvider(null));

// ── Labeled pairs (tuning ground truth) ────────────────────────────────────
//
// POSITIVES: the edit-variant class this identity MUST merge — source
// suffixes, truncations, qualifier swaps, reorders, light morphology.
// These are the real-world corroboration killers under exact-hash identity.
const POSITIVE_PAIRS = [
  ['Fed holds interest rates steady amid inflation concerns', 'Fed holds rates steady as inflation concerns persist'],
  ['Magnitude 6.8 earthquake strikes northern Chile', '6.8-magnitude earthquake hits northern Chile'],
  ['EU approves 12th sanctions package against Russia', 'European Union approves 12th sanctions package on Russia'],
  ['Ukraine drone strike hits Russian oil refinery in Ryazan region', 'Ukraine drone strike hits Russian oil refinery'],
  ['Iran threatens to close Strait of Hormuz if US blockade continues', 'Iran threatens to close Strait of Hormuz — live updates'],
  ['Apple unveils new AI features at WWDC keynote', 'At WWDC keynote, Apple unveils new AI features'],
  ['Iranian officials threaten Hormuz closure over sanctions', 'Iran officials threaten Hormuz closure over sanctions'],
  ['Nigeria fuel subsidy protests spread to Lagos as unions join', 'Nigeria fuel subsidy protests spread to Lagos'],
  ['Turkey hikes interest rates to 50% in surprise move', 'Turkey hikes rates to 50% in surprise move'],
  ['China exports fall 7.5% in June, worse than expected', 'Chinese exports fell 7.5% in June, worse than expected'],
  // Severe RSS truncation (>=50% token drop) — the containment-rescue
  // class the old word-overlap dedup metric guaranteed (#4924 review).
  ['Nigeria fuel subsidy protests spread to Lagos as unions join nationwide strike over cost of living', 'Nigeria fuel subsidy protests spread to Lagos'],
  ['Turkey central bank hikes interest rates to 50% in surprise move to combat runaway inflation pressures', 'Turkey central bank hikes interest rates'],
  // Source-attribution suffix must not shift identity (#4924 cross-model).
  ['Iran threatens to close Strait of Hormuz - Reuters', 'Iran threatens to close Strait of Hormuz'],
];

// NEGATIVES: same-topic-DIFFERENT-event pairs that must stay apart —
// entity swaps, action swaps, parameter swaps, actor-direction flips.
const NEGATIVE_PAIRS = [
  ['Iran seizes oil tanker in Strait of Hormuz', 'Iran threatens to close Strait of Hormuz'],
  ['Fed holds rates steady amid inflation concerns', 'Fed cuts rates by 25 basis points amid slowing economy'],
  ['Magnitude 6.8 earthquake strikes northern Chile', 'Magnitude 5.9 earthquake strikes southern Peru'],
  ['Ukraine drone strike hits Russian oil refinery', 'Russian drone strike hits Ukrainian energy grid'],
  ['Apple unveils new AI features at WWDC keynote', 'Google unveils new AI features at I/O keynote'],
  ['Turkey hikes interest rates to 50% in surprise move', 'Argentina hikes interest rates to 50% in surprise move'],
  ['Nigeria fuel subsidy protests spread to Lagos', 'Kenya tax protests spread to Nairobi'],
  ['US imposes new sanctions on Iranian oil exports', 'US lifts sanctions on Venezuelan oil exports'],
  ['Israel strikes Hezbollah targets in southern Lebanon', 'Hezbollah strikes Israeli positions in northern Israel'],
  // Shared publisher suffix must NOT pull distinct stories together —
  // pre-fix, the entity-boosted "Reuters" token added shared mass to
  // every same-wrapper pair (#4924 cross-model finding).
  ['Apple unveils new AI features at WWDC keynote - Reuters', 'Google unveils new AI features at I/O keynote - Reuters'],
];

// KNOWN LIMIT (documented, deliberately NOT asserted as separable): two
// events differing by ONE unboosted content token sit above the
// threshold — "China exports fall 7.5%" vs "China imports fall 7.5%",
// "12th sanctions package" vs "13th". No lexical similarity can order
// these below genuine rewrites of one story; the 96h ingest window and
// entity-corroboration signals bound the damage. Revisit when a semantic
// provider lands behind setStoryVectorProvider.

describe('labeled-pair separation (tuning ground truth)', () => {
  it('every edit-variant positive pair clears the threshold', () => {
    for (const [a, b] of POSITIVE_PAIRS) {
      const sim = storySimilarity(a, b);
      assert.ok(
        sim >= STORY_SIMILARITY_THRESHOLD,
        `expected same-story (${sim.toFixed(3)} >= ${STORY_SIMILARITY_THRESHOLD}): "${a}" ~ "${b}"`,
      );
    }
  });

  it('every distinct-event negative pair stays below the threshold', () => {
    for (const [a, b] of NEGATIVE_PAIRS) {
      const sim = storySimilarity(a, b);
      assert.ok(
        sim < STORY_SIMILARITY_THRESHOLD,
        `expected distinct (${sim.toFixed(3)} < ${STORY_SIMILARITY_THRESHOLD}): "${a}" vs "${b}"`,
      );
    }
  });

  it('separation holds with margin on both sides (retune trip-wire)', () => {
    const minPos = Math.min(...POSITIVE_PAIRS.map(([a, b]) => storySimilarity(a, b)));
    const maxNeg = Math.max(...NEGATIVE_PAIRS.map(([a, b]) => storySimilarity(a, b)));
    assert.ok(minPos - STORY_SIMILARITY_THRESHOLD >= 0.015, `positive floor too close: ${minPos.toFixed(3)}`);
    assert.ok(STORY_SIMILARITY_THRESHOLD - maxNeg >= 0.015, `negative ceiling too close: ${maxNeg.toFixed(3)}`);
  });
});

describe('storyVector / cosineSimilarity', () => {
  it('identical texts are similarity 1', () => {
    const sim = storySimilarity('Iran threatens to close Strait of Hormuz', 'Iran threatens to close Strait of Hormuz');
    assert.ok(Math.abs(sim - 1) < 1e-9);
  });

  it('empty/garbage text yields null vector and zero similarity', () => {
    assert.equal(storyVector(''), null);
    assert.equal(storyVector('   —— !!'), null);
    assert.equal(storySimilarity('', 'Iran threatens Hormuz'), 0);
    assert.equal(cosineSimilarity(null, storyVector('Iran threatens Hormuz')), 0);
  });

  it('is symmetric', () => {
    const a = 'Fed holds rates steady amid inflation concerns';
    const b = 'Fed holds interest rates steady';
    assert.ok(Math.abs(storySimilarity(a, b) - storySimilarity(b, a)) < 1e-12);
  });

  it('unsegmented scripts (CJK) still produce vectors and match near-duplicates', () => {
    const a = '日本銀行が金利を引き上げ、市場に衝撃';
    const b = '日本銀行が金利を引き上げ';
    assert.ok(storyVector(a), 'CJK title must vectorize');
    assert.ok(storySimilarity(a, b) > storySimilarity(a, '米国大統領がメキシコ国境を視察'));
  });

  it('case-only differences do not change identity (boost is view-internal)', () => {
    const sim = storySimilarity(
      'IRAN THREATENS TO CLOSE STRAIT OF HORMUZ',
      'Iran threatens to close Strait of Hormuz',
    );
    assert.ok(sim >= STORY_SIMILARITY_THRESHOLD, `all-caps variant must merge (got ${sim.toFixed(3)})`);
  });
});

describe('clusterTexts', () => {
  it('groups edit variants and keeps distinct events apart', () => {
    const texts = [
      'Iran threatens to close Strait of Hormuz if US blockade continues',
      'Iran threatens to close Strait of Hormuz — live updates',
      'Stock market rallies on tech earnings report',
      'Iran seizes oil tanker in Strait of Hormuz',
    ];
    const clusters = clusterTexts(texts);
    const byMember = new Map();
    clusters.forEach((cluster, ci) => cluster.forEach((i) => byMember.set(i, ci)));
    assert.equal(byMember.get(0), byMember.get(1), 'variants must share a cluster');
    assert.notEqual(byMember.get(0), byMember.get(2), 'unrelated story must not join');
    assert.notEqual(byMember.get(0), byMember.get(3), 'same-topic different event must not join');
    assert.equal(clusters.flat().length, texts.length, 'every index appears exactly once');
  });

  it('is deterministic and order-stable for a fixed input', () => {
    const texts = [
      'Turkey hikes interest rates to 50% in surprise move',
      'Turkey hikes rates to 50% in surprise move',
      'Kenya tax protests spread to Nairobi',
    ];
    assert.deepEqual(clusterTexts(texts), clusterTexts(texts));
  });

  it('respects an explicit threshold override', () => {
    const texts = ['Fed holds interest rates steady', 'Fed holds rates steady'];
    assert.equal(clusterTexts(texts, { threshold: 0.999 }).length, 2);
    assert.equal(clusterTexts(texts).length, 1);
  });
});

describe('candidateTokens / normalizeStoryText', () => {
  it('drops short ASCII tokens and keeps non-ASCII with bigrams', () => {
    const toks = candidateTokens('US to cut rates 日本');
    assert.ok(!toks.has('to'));
    assert.ok(toks.has('rates'));
    assert.ok(toks.has('日本'));
    assert.ok(toks.has('日本'.slice(0, 2)));
  });

  it('normalizeStoryText strips punctuation and collapses whitespace', () => {
    assert.equal(normalizeStoryText('  Fed — holds,  rates!  '), 'fed holds rates');
  });
});

describe('setStoryVectorProvider (semantic upgrade seam)', () => {
  it('routes storyVector through the provider and restores on null', () => {
    const fixed = { u: new Float64Array(4).fill(0.5), b: new Float64Array(4).fill(0.5) };
    setStoryVectorProvider(() => fixed);
    assert.equal(storyVector('anything'), fixed);
    assert.ok(Math.abs(storySimilarity('a b c', 'x y z') - 1) < 1e-9, 'provider vectors drive similarity');
    setStoryVectorProvider(null);
    assert.notEqual(storyVector('Iran threatens Hormuz closure'), fixed);
  });
});

// ── assignStoryIdentity (list-feed-digest integration surface) ─────────────

import { createHash } from 'node:crypto';
import { assignStoryIdentity, deduplicateHeadlines } from '../server/worldmonitor/news/v1/dedup.mjs';

const sha256Hex = async (text) => createHash('sha256').update(text).digest('hex');
const normalizeTitle = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

describe('assignStoryIdentity (#4919 acceptance)', () => {
  it('REGRESSION: corroboration rises when the same event arrives with different wording', async () => {
    // Under the old exact-hash identity these three wordings were three
    // separate stories with corroborationCount=1 each.
    const items = [
      { title: 'Iran threatens to close Strait of Hormuz if US blockade continues', source: 'Reuters' },
      { title: 'Iran threatens to close Strait of Hormuz — live updates', source: 'BBC' },
      { title: 'Iran threatens to close Strait of Hormuz if US blockade continues', source: 'AP' },
      { title: 'Stock market rallies on tech earnings report', source: 'CNBC' },
    ];
    const assignment = await assignStoryIdentity(items, normalizeTitle, sha256Hex);
    assert.equal(assignment.get(items[0]).corroborationCount, 3, 'three sources, three wordings, ONE story');
    assert.equal(assignment.get(items[0]).titleHash, assignment.get(items[1]).titleHash);
    assert.equal(assignment.get(items[0]).titleHash, assignment.get(items[2]).titleHash);
    assert.equal(assignment.get(items[3]).corroborationCount, 1);
    assert.notEqual(assignment.get(items[3]).titleHash, assignment.get(items[0]).titleHash);
  });

  it('singleton clusters hash exactly as the old identity (story:track keys unchanged)', async () => {
    const items = [{ title: 'Kenya tax protests spread to Nairobi', source: 'AFP' }];
    const assignment = await assignStoryIdentity(items, normalizeTitle, sha256Hex);
    assert.equal(
      assignment.get(items[0]).titleHash,
      await sha256Hex(normalizeTitle(items[0].title)),
    );
  });

  it('canonical hash is order-independent (stable across batch orderings)', async () => {
    const a = { title: 'Iran threatens to close Strait of Hormuz — live updates', source: 'BBC' };
    const b = { title: 'Iran threatens to close Strait of Hormuz', source: 'Reuters' };
    const first = await assignStoryIdentity([a, b], normalizeTitle, sha256Hex);
    const second = await assignStoryIdentity([b, a], normalizeTitle, sha256Hex);
    assert.equal(first.get(a).titleHash, second.get(a).titleHash);
  });

  it('#6428: one publisher across its own feed labels is not corroboration', async () => {
    const items = [
      { title: 'Iran threatens to close Strait of Hormuz if US blockade continues', source: 'Reuters World' },
      { title: 'Iran threatens to close Strait of Hormuz — live updates', source: 'Reuters US' },
      { title: 'Iran threatens to close Strait of Hormuz if US blockade continues', source: 'Reuters Business' },
    ];
    const assignment = await assignStoryIdentity(items, normalizeTitle, sha256Hex);
    assert.equal(
      assignment.get(items[0]).corroborationCount,
      1,
      'three Reuters feed labels are one wire, not three independent sources',
    );

    // Premise check: the same three wordings under three real publishers must
    // still corroborate, or the assertion above would pass on a clustering
    // failure rather than on the family collapse.
    const distinct = items.map((item, i) => ({
      ...item,
      source: ['Reuters World', 'BBC World', 'Al Jazeera'][i],
    }));
    const distinctAssignment = await assignStoryIdentity(distinct, normalizeTitle, sha256Hex);
    assert.equal(distinctAssignment.get(distinct[0]).corroborationCount, 3);
  });

  it('duplicate sources within a cluster count once', async () => {
    const items = [
      { title: 'Turkey hikes interest rates to 50% in surprise move', source: 'Reuters' },
      { title: 'Turkey hikes rates to 50% in surprise move', source: 'Reuters' },
    ];
    const assignment = await assignStoryIdentity(items, normalizeTitle, sha256Hex);
    assert.equal(assignment.get(items[0]).corroborationCount, 1, 'same outlet republishing is not corroboration');
  });

  it('every item receives an assignment', async () => {
    const items = [
      { title: 'A completely unique story about lunar mining', source: 'X' },
      { title: '', source: 'Y' },
      { title: '!!!', source: 'Z' },
    ];
    const assignment = await assignStoryIdentity(items, normalizeTitle, sha256Hex);
    for (const item of items) assert.ok(assignment.get(item), `missing assignment for "${item.title}"`);
  });
});

describe('deduplicateHeadlines (shared-similarity rewrite)', () => {
  it('keeps unvectorizable headlines rather than dropping them', () => {
    const result = deduplicateHeadlines(['', '¡!', 'Fed holds rates steady']);
    assert.equal(result.length, 3);
  });
});


// ── #4924 review-round regression tests ────────────────────────────────────

describe('canonical identity stability (#4924 review)', () => {
  it('REGRESSION: a later-published wording that sorts lexicographically earlier must NOT steal the canonical', async () => {
    // Reliability P1 + learnings: pre-fix, canonical = lexicographic-min
    // member of the CURRENT batch, so "Ahead of talks, Iran threatens…"
    // (sorts before "Iran threatens…") joining a live cluster flipped the
    // story:track id, resetting mentionCount/firstSeen and re-firing
    // BREAKING mid-lifecycle.
    const a = { title: 'Iran threatens to close Strait of Hormuz', source: 'Reuters', publishedAt: 100 };
    const b = { title: 'Iran threatens to close Strait of Hormuz — live updates', source: 'BBC', publishedAt: 200 };
    const build1 = await assignStoryIdentity([a, b], normalizeTitle, sha256Hex);

    const c = { title: 'Ahead of talks, Iran threatens to close Strait of Hormuz', source: 'AFP', publishedAt: 300 };
    const build2 = await assignStoryIdentity([a, b, c], normalizeTitle, sha256Hex);

    assert.ok(normalizeTitle(c.title) < normalizeTitle(a.title), 'fixture: C must sort before A for the test to bite');
    assert.equal(build2.get(a).titleHash, build1.get(a).titleHash, 'canonical must stay anchored on the earliest-published member');
    assert.equal(build2.get(c).titleHash, build1.get(a).titleHash, 'new wording adopts the existing identity');
    assert.equal(build2.get(a).corroborationCount, 3);
  });

  it('missing publishedAt falls back to lexicographic-min (deterministic)', async () => {
    const a = { title: 'Iran threatens to close Strait of Hormuz — live updates', source: 'BBC' };
    const b = { title: 'Iran threatens to close Strait of Hormuz', source: 'Reuters' };
    const assignment = await assignStoryIdentity([a, b], normalizeTitle, sha256Hex);
    assert.equal(assignment.get(a).titleHash, await sha256Hex(normalizeTitle(b.title)));
  });

  it('cluster membership is input-order independent (union-find, not greedy seed)', () => {
    // Bridge case: A~B and B~C above threshold, A~C possibly below —
    // greedy first-seed clustering could split this differently
    // depending on which item arrived first; connected components
    // cannot.
    const texts = [
      'Turkey central bank hikes interest rates to 50% in surprise move',
      'Turkey central bank hikes interest rates to 50%',
      'Turkey central bank hikes rates',
      'Kenya tax protests spread to Nairobi',
    ];
    const perms = [
      [0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1],
    ];
    const canonicalSizes = perms.map((perm) => {
      const clusters = clusterTexts(perm.map((i) => texts[i]));
      return clusters.map((c) => c.length).sort().join(',');
    });
    assert.ok(canonicalSizes.every((sig) => sig === canonicalSizes[0]),
      `cluster size signature must be order-invariant, got: ${canonicalSizes.join(' | ')}`);
  });
});

describe('degenerate titles (#4924 review)', () => {
  it('emoji/punctuation-only titles get per-item sentinel identities, not one shared phantom track', async () => {
    const items = [
      { title: '🔥🔥🔥', source: 'FeedA' },
      { title: '!!!', source: 'FeedB' },
      { title: '🔥🔥🔥', source: 'FeedC' },
    ];
    const assignment = await assignStoryIdentity(items, normalizeTitle, sha256Hex);
    const hashes = items.map((i) => assignment.get(i).titleHash);
    assert.equal(new Set(hashes).size, 3, 'each contentless item gets its own identity');
    for (const item of items) {
      assert.equal(assignment.get(item).corroborationCount, 1, 'contentless titles never corroborate each other');
    }
  });
});

describe('attribution suffixes and length clamp (#4924 review)', () => {
  it('stripAttributionSuffix removes trailing publisher attributions', () => {
    assert.equal(stripAttributionSuffix('Iran threatens Hormuz - Reuters'), 'Iran threatens Hormuz');
    assert.equal(stripAttributionSuffix('Iran threatens Hormuz - example.com'), 'Iran threatens Hormuz');
    assert.equal(stripAttributionSuffix('Iran-Iraq talks resume'), 'Iran-Iraq talks resume', 'mid-title hyphens untouched');
  });

  it('a pathologically long title does not change identity behavior (clamped, still vectorizes)', () => {
    const base = 'Iran threatens to close Strait of Hormuz';
    const long = base + ' ' + 'filler'.repeat(2000);
    assert.ok(storyVector(long), 'clamped long title still vectorizes');
    assert.ok(storySimilarity(base, base + ' amid rising tension') >= STORY_SIMILARITY_THRESHOLD);
  });
});

// ── list-feed-digest integration wiring (source-textual, mirrors the
// digest-buildDigest-*-passthrough test pattern) ───────────────────────────

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('list-feed-digest story-identity wiring (#4924 review)', () => {
  const digestSrc = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../server/worldmonitor/news/v1/list-feed-digest.ts'),
    'utf-8',
  );

  it('assigns story identity before AI-cache enrichment and scoring', () => {
    const assignAt = digestSrc.indexOf('await assignStoryIdentity(allItems');
    const enrichAt = digestSrc.indexOf('await enrichWithAiCache(allItems)');
    assert.ok(assignAt > -1 && enrichAt > -1);
    assert.ok(assignAt < enrichAt, 'identity must be assigned before enrichment/scoring consumes it');
  });

  it('both corroboration consumers read the cluster-wide count from the item', () => {
    assert.match(digestSrc, /Math\.max\(item\.corroborationCount, item\.entityCorroborationCount\)/,
      'importance scoring must consume the cluster-wide corroboration');
    assert.match(digestSrc, /const sourceCount = item\.corroborationCount \?\? 1;/,
      'per-category slice must consume the cluster-wide corroboration');
  });

  it('mentionCount increments once per unique hash per cycle, not once per member', () => {
    const hincrbyAt = digestSrc.indexOf("['HINCRBY', trackKey, 'mentionCount', '1']");
    const guardAt = digestSrc.indexOf('if (!writtenHashes.has(hash))');
    assert.ok(guardAt > -1, 'unique-hash guard must exist');
    assert.ok(hincrbyAt > guardAt, 'HINCRBY must sit inside the once-per-hash guard');
    // Per-member set-shaped writes stay outside the guard.
    const saddAt = digestSrc.indexOf("['SADD', sourcesKey, item.source]");
    assert.ok(saddAt > hincrbyAt, 'per-member SADD stays outside the once-per-hash block');
  });

  it('coverage-miss fallback is observable, not silent', () => {
    assert.match(digestSrc, /story-identity coverage miss/, 'fallback branch must log');
  });

  it('canonical adoption requires persisted anchor eligibility', () => {
    assert.match(digestSrc, /'anchorEligible', anchorEligible \? '1' : '0'/);
    assert.match(
      digestSrc,
      /isIdentityAnchorEligible\(item, identity\.corroborationCount\)/,
      'the batch-default gate must use cluster-wide corroboration before items are mutated',
    );
    assert.match(digestSrc, /clusterAnchorEligibleByFinalHash/,
      'the persisted eligibility stamp must retain trusted members excluded by the display cap');
    assert.match(digestSrc, /'firstSeen', 'lastSeen', 'anchorEligible'/);
    assert.match(digestSrc, /parseFreshEligibleTrackFirstSeen\(/,
      'legacy or explicitly ineligible tracks must not anchor on firstSeen alone');
    assert.match(digestSrc, /MAX_REDIS_PIPELINE_COMMANDS = 1000/,
      'tracking writes must declare the hard Redis command limit');
    assert.match(digestSrc, /STORY_ALIAS_PUBLISH_SCRIPT/,
      'each alias cohort must use the fenced atomic publication script');
    assert.match(digestSrc, /STORY_ALIAS_PUBLICATION_LOCK_KEY/,
      'alias publication must use one shared cross-isolate lease');
    assert.match(digestSrc, /aliasLockToken/,
      'the publication script must receive the writer token as a fence');
    assert.match(digestSrc, /memberHashes\.size > MAX_REDIS_PIPELINE_COMMANDS/,
      'an oversized alias cohort must be deferred instead of split into a partial generation');
  });
});

describe('hot-bucket mega-story pre-union (#4924 external review)', () => {
  it('251 identical titles cluster together even when every token bucket is hot', () => {
    const texts = Array.from({ length: 251 }, () => 'Iran threatens to close Strait of Hormuz');
    texts.push('Kenya tax protests spread to Nairobi');
    const clusters = clusterTexts(texts);
    const sizes = clusters.map((c) => c.length).sort((a, b) => b - a);
    assert.equal(sizes[0], 251, 'identical titles must union regardless of bucket caps');
    assert.equal(sizes[1], 1);
  });
});

// ── #4924 external-review round: cross-cycle continuity + TTL ordering ─────

import { adoptExistingCanonical } from '../server/worldmonitor/news/v1/dedup.mjs';

const sha256HexNode = sha256Hex;
const normalizeBasic = normalizeTitle;

describe('cross-cycle canonical adoption (#4924 external review P1)', () => {
  it('REGRESSION: two-cycle A+B -> B-only keeps the story identity via alias adoption', async () => {
    const A = { title: 'Iran threatens to close Strait of Hormuz', source: 'Reuters', publishedAt: 1_000 };
    const B = { title: 'Iran warns it may close the Strait of Hormuz', source: 'BBC', publishedAt: 2_000 };

    // Cycle 1: A+B cluster; A (earlier publishedAt) anchors the canonical.
    const cycle1 = await assignStoryIdentity([A, B], normalizeBasic, sha256HexNode);
    const identity1 = cycle1.get(A);
    assert.equal(identity1.titleHash, cycle1.get(B).titleHash, 'A and B share one identity in cycle 1');
    assert.ok(identity1.memberTitleHashes.length >= 2, 'both member hashes exposed for alias persistence');

    // The digest persists memberHash -> canonical alias rows; simulate them.
    const aliasMap = new Map(identity1.memberTitleHashes.map((h) => [h, identity1.titleHash]));

    // Cycle 2: only B appears — batch-derived canonical would be B itself...
    const cycle2 = await assignStoryIdentity([{ ...B }], normalizeBasic, sha256HexNode);
    const identity2 = [...cycle2.values()][0];
    assert.notEqual(identity2.titleHash, identity1.titleHash, 'without adoption, B forks a fresh identity');

    // ...but adoption re-anchors to the live canonical from cycle 1.
    const adopted = adoptExistingCanonical(identity2.memberTitleHashes, identity2.titleHash, aliasMap);
    assert.equal(adopted, identity1.titleHash, 'B-only cycle must continue the cycle-1 story track');
  });

  it('adoption is deterministic: most-common live target wins, ties break lexicographically', () => {
    const aliasMap = new Map([['m1', 'hash-b'], ['m2', 'hash-a'], ['m3', 'hash-b']]);
    assert.equal(adoptExistingCanonical(['m1', 'm2', 'm3'], 'default', aliasMap), 'hash-b');
    const tied = new Map([['m1', 'hash-b'], ['m2', 'hash-a']]);
    assert.equal(adoptExistingCanonical(['m1', 'm2'], 'default', tied), 'hash-a', 'tie -> smallest hash');
    assert.equal(adoptExistingCanonical(['m1'], 'default', new Map()), 'default', 'no live alias -> batch canonical');
    assert.equal(adoptExistingCanonical(undefined, 'default', aliasMap), 'default');
  });
});

describe('adopt-existing-track canonical (#4925 item 1)', () => {
  it('REGRESSION: a backdated hostile wording cannot seize a live story identity', async () => {
    // The genuine story, seen first. Its canonical anchors a story:track row
    // whose firstSeen the digest HSETNXd at that moment.
    const genuine = { title: 'Iran threatens to close Strait of Hormuz', source: 'Reuters', publishedAt: 5_000 };
    const genuineIdentity = [...(await assignStoryIdentity([genuine], normalizeBasic, sha256HexNode)).values()][0];
    const genuineHash = genuineIdentity.titleHash;

    // The hostile feed backdates INSIDE the freshness window, so it wins the
    // publishedAt comparison that picks the batch-derived canonical, and it
    // publishes two wordings so its own alias rows out-number the genuine
    // story's single one.
    const hostileA = { title: 'Iran threatens to close the Strait of Hormuz soon', source: 'Farm A', publishedAt: 1_000 };
    const hostileB = { title: 'Iran threatens to close Strait of Hormuz shortly', source: 'Farm B', publishedAt: 2_000 };
    const batch = await assignStoryIdentity([genuine, hostileA, hostileB], normalizeBasic, sha256HexNode);
    const clustered = batch.get(genuine);
    assert.equal(clustered.titleHash, batch.get(hostileA).titleHash, 'all three wordings must land in one cluster');
    assert.equal(clustered.titleHash, batch.get(hostileB).titleHash, 'all three wordings must land in one cluster');
    const hostileHashA = await sha256HexNode(normalizeBasic(hostileA.title));
    const hostileHashB = await sha256HexNode(normalizeBasic(hostileB.title));
    assert.equal(clustered.titleHash, hostileHashA, 'backdating does win the batch-derived default');

    // The alias vote is most-common-wins, so two hostile wordings out-vote the
    // genuine story and absorb its track: phase re-fires, counts reset.
    const hostileCanonical = 'hostile-canonical-hash';
    const aliasMap = new Map([
      [genuineHash, genuineHash],
      [hostileHashA, hostileCanonical],
      [hostileHashB, hostileCanonical],
    ]);
    assert.equal(
      adoptExistingCanonical(clustered.memberTitleHashes, clustered.titleHash, aliasMap),
      hostileCanonical,
      'alias-only adoption hands the cluster to the hostile canonical',
    );

    // firstSeen is not publisher-controlled: the digest HSETNXs it when it
    // first observes the hash. The genuine story was seen first, so its track
    // is older and the cluster keeps its identity.
    const trackFirstSeen = new Map([
      [genuineHash, 1_000_000],
      [hostileHashA, 9_000_000],
      [hostileHashB, 9_000_001],
    ]);
    assert.equal(
      adoptExistingCanonical(clustered.memberTitleHashes, clustered.titleHash, aliasMap, trackFirstSeen),
      genuineHash,
      'the oldest live story:track row must win over both the backdated default and the alias vote',
    );
  });

  it('REGRESSION: a hostile pre-seed cannot outrank a later trusted anchor', async () => {
    const hostile = {
      title: 'Iran threatens to close Strait of Hormuz',
      source: 'Farm A',
      publishedAt: 1_000,
    };
    const trusted = {
      title: 'Iran warns it may close the Strait of Hormuz',
      source: 'Reuters',
      publishedAt: 2_000,
    };
    const batch = await assignStoryIdentity([hostile, trusted], normalizeBasic, sha256HexNode);
    const clustered = batch.get(hostile);
    const hostileHash = await sha256HexNode(normalizeBasic(hostile.title));
    const trustedHash = await sha256HexNode(normalizeBasic(trusted.title));

    assert.equal(clustered.titleHash, batch.get(trusted).titleHash, 'trusted and hostile wordings must cluster');
    assert.ok(clustered.memberTitleHashes.includes(hostileHash));
    assert.ok(clustered.memberTitleHashes.includes(trustedHash));

    // The reader drops the hostile self-alias/track because its persisted
    // anchorEligible stamp is not '1'. The later trusted member has a valid
    // eligible track, so it wins even though the hostile batch default was
    // backdated earlier.
    const eligibleAliases = new Map([[trustedHash, trustedHash]]);
    const eligibleTracks = new Map([[trustedHash, 2_000_000]]);
    assert.equal(
      adoptExistingCanonical(clustered.memberTitleHashes, hostileHash, eligibleAliases, eligibleTracks),
      trustedHash,
    );
  });

  it('REGRESSION: an ineligible hostile A+B alias cannot bypass a later Reuters anchor', async () => {
    const hostileA = { title: 'Iran threatens to close Strait of Hormuz', source: 'Farm A', publishedAt: 1_000 };
    const hostileB = { title: 'Iran warns it may close the Strait of Hormuz', source: 'Farm A', publishedAt: 1_100 };
    const trusted = { title: 'Iran warns it could close the Strait of Hormuz, Reuters reports', source: 'Reuters', publishedAt: 2_000 };

    // Cycle 1: the hostile feed pre-seeds an A+B canonical and persists B's
    // alias to that canonical. Its target track is explicitly ineligible.
    const cycle1 = await assignStoryIdentity([hostileA, hostileB], normalizeBasic, sha256HexNode);
    const hostileCanonical = cycle1.get(hostileA).titleHash;
    const hostileBHash = await sha256HexNode(normalizeBasic(hostileB.title));

    // Cycle 2: B + Reuters cluster. The hostile alias target is absent from
    // the eligible alias map because its target track failed the anchor gate;
    // Reuters remains the batch-derived/default canonical.
    const cycle2 = await assignStoryIdentity([hostileB, trusted], normalizeBasic, sha256HexNode);
    const clustered = cycle2.get(hostileB);
    const trustedHash = await sha256HexNode(normalizeBasic(trusted.title));
    assert.equal(clustered.titleHash, cycle2.get(trusted).titleHash, 'B and Reuters must cluster');
    assert.ok(clustered.memberTitleHashes.includes(hostileBHash));
    assert.ok(clustered.memberTitleHashes.includes(trustedHash));

    const aliasesAfterTargetValidation = new Map([[trustedHash, trustedHash]]);
    assert.equal(
      adoptExistingCanonical(
        clustered.memberTitleHashes,
        trustedHash,
        aliasesAfterTargetValidation,
        new Map(),
      ),
      trustedHash,
      'a hostile alias whose target track is not anchor-eligible must be ignored',
    );
    assert.notEqual(hostileCanonical, trustedHash, 'the hostile pre-seed must not remain the default');
  });

  it('precedence: oldest live track, then most-common alias, then the batch default', () => {
    const members = ['m1', 'm2', 'm3'];
    const aliasMap = new Map([['m1', 'alias-target'], ['m2', 'alias-target']]);

    // 1. A live track with no superseding alias outranks the alias vote even
    //    when the alias vote is unanimous, because only firstSeen is beyond
    //    a feed's reach.
    assert.equal(
      adoptExistingCanonical(members, 'default', aliasMap, new Map([['m3', 500]])),
      'm3',
    );
    // 2. No track row -> the #4924 alias vote is unchanged.
    assert.equal(adoptExistingCanonical(members, 'default', aliasMap, new Map()), 'alias-target');
    // 3. Neither -> the batch-derived canonical, as before.
    assert.equal(adoptExistingCanonical(members, 'default', new Map(), new Map()), 'default');
    // 4. Omitting the argument entirely keeps the pre-#4925 behaviour, so the
    //    17 existing three-argument call sites are unaffected.
    assert.equal(adoptExistingCanonical(members, 'default', aliasMap), 'alias-target');
  });

  it('REGRESSION: a superseded member track cannot defeat alias continuity across three cycles', () => {
    // Cycle 1: A-only creates A's track and self-alias.
    const tracks = new Map([['A', 100]]);
    let aliases = new Map([['A', 'A']]);
    assert.equal(adoptExistingCanonical(['A'], 'A', aliases, tracks), 'A');

    // Cycle 2: B-only creates its own live track and self-alias.
    tracks.set('B', 200);
    aliases = new Map([['A', 'A'], ['B', 'B']]);
    assert.equal(adoptExistingCanonical(['B'], 'B', aliases, tracks), 'B');

    // Cycle 3: A+B keeps the older A identity. The digest then persists the
    // final aliases, including B -> A, while B's old track is still live.
    assert.equal(adoptExistingCanonical(['A', 'B'], 'A', aliases, tracks), 'A');
    aliases = new Map([['A', 'A'], ['B', 'A']]);

    // Cycle 4: A is absent. B's own live row must not re-fork the story;
    // alias adoption must retain A even though the canonical is not a member.
    assert.equal(
      adoptExistingCanonical(['B'], 'B', aliases, tracks),
      'A',
      'a member track superseded by B -> A must defer to the aliased canonical',
    );
  });

  it('skips only tracks with a different alias and preserves deterministic alias ties', () => {
    const members = ['m1', 'm2'];
    const aliases = new Map([['m1', 'z-canonical'], ['m2', 'a-canonical']]);
    const tracks = new Map([['m1', 1], ['m2', 2]]);

    // Both member tracks are superseded, so the alias tie-break remains
    // lexicographic and independent of member/track insertion order.
    assert.equal(
      adoptExistingCanonical([...members].reverse(), 'default', aliases, tracks),
      'a-canonical',
    );

    // A self-alias is not a supersession: the canonical member's own track
    // remains eligible under rule 1.
    assert.equal(
      adoptExistingCanonical(['m1', 'm2'], 'default', new Map([['m1', 'm1'], ['m2', 'other']]), tracks),
      'm1',
    );
  });

  it('track adoption is deterministic and ignores unusable stamps', () => {
    const members = ['m1', 'm2', 'm3'];
    assert.equal(
      adoptExistingCanonical(members, 'default', new Map(), new Map([['m1', 900], ['m2', 100], ['m3', 400]])),
      'm2',
      'oldest firstSeen wins',
    );
    assert.equal(
      adoptExistingCanonical(members, 'default', new Map(), new Map([['m3', 100], ['m1', 100]])),
      'm1',
      'equal firstSeen ties break to the lexicographically smallest hash',
    );
    assert.equal(
      adoptExistingCanonical(members, 'default', new Map(), { m2: 250 }),
      'm2',
      'a plain object is accepted, matching the alias parameter',
    );
    for (const unusable of [Number.NaN, Infinity, null, undefined, '100']) {
      assert.equal(
        adoptExistingCanonical(members, 'default', new Map(), new Map([['m1', unusable]])),
        'default',
        `an unusable firstSeen (${String(unusable)}) must not anchor the story`,
      );
    }
  });

  it('a canonical absent from the batch still needs the alias vote', () => {
    // Rule 1 reads story:track rows keyed by MEMBER hashes. A canonical that
    // dropped out of the batch is not a member, so it has no row to find here
    // — which is exactly the #4924 case the alias vote exists for. The two
    // rules cover different gaps; neither replaces the other.
    const members = ['m1', 'm2'];
    const aliasMap = new Map([['m1', 'absent-canonical'], ['m2', 'absent-canonical']]);
    assert.equal(
      adoptExistingCanonical(members, 'default', aliasMap, new Map([['nobody', 1]])),
      'absent-canonical',
    );
  });
});

describe('story key TTL ordering (#4924 external review P2)', () => {
  it('EXPIRE for sources/peak keys is queued with the per-member creating writes, never before them', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../server/worldmonitor/news/v1/list-feed-digest.ts'),
      'utf-8',
    );
    const onceBlock = src.slice(src.indexOf("['HINCRBY', trackKey"), src.indexOf("['ZADD', peakKey, 'GT'"));
    assert.ok(!onceBlock.includes("['EXPIRE', sourcesKey"),
      'sources EXPIRE must not sit in the once-per-hash pre-block — EXPIRE on a missing key is a no-op and the later SADD creates a persistent key');
    assert.ok(!onceBlock.includes("['EXPIRE', peakKey"),
      'peak EXPIRE must not sit in the once-per-hash pre-block');
    const memberBlockStart = src.indexOf("['ZADD', peakKey, 'GT'");
    const memberBlock = src.slice(memberBlockStart, src.indexOf('const evidenceTimeoutMs', memberBlockStart));
    assert.ok(memberBlock.includes("['EXPIRE', sourcesKey") && memberBlock.includes("['EXPIRE', peakKey"),
      'both EXPIREs must follow the creating SADD/ZADD in the per-member block');
    assert.match(src, /String\(STORY_TTL\)/, 'alias rows persisted with story TTL');
    assert.match(src, /aliasResults\.length !== aliasScriptChunk\.length/,
      'a short alias-script batch response must stop remaining groups');
    assert.match(src, /aliasResults\.some\(\(result\) => result\?\.result !== 1\)/,
      'an unconfirmed or stale fenced alias publication must stop remaining groups');
    assert.match(
      src,
      /adoptExistingCanonical\(\s*identity\.memberTitleHashes,\s*batchDefaultHash,\s*aliasTargetByHash,\s*trackFirstSeenByHash,\s*\)/,
      'digest must adopt live canonicals from alias targets AND story:track first-seen stamps (#4925 item 1) before assigning hashes',
    );
    // #4925 item 1: a member hash's alias row and its track row must be read
    // in the SAME atomic transaction, or a cluster can decide from two Redis
    // states observed at different moments.
    assert.match(
      src,
      /runRedisTransaction\(\[\s*\.\.\.chunk\.map\(\(h\) => \['GET', STORY_ALIAS_KEY\(h\)\]\),\s*\.\.\.chunk\.map\(\(h\) => \['HMGET', STORY_TRACK_KEY\(h\), 'firstSeen', 'lastSeen', 'anchorEligible'\]\),\s*\], false, timeoutMs\)/,
      'alias and story:track reads for a hash must share one atomic transaction',
    );
    // ...and that call must stay bounded: two commands per hash means the hash
    // budget is half the command budget STORY_BATCH_SIZE is sized against.
    const adoptionBatch = src.match(/const ADOPTION_BATCH_SIZE = (\d+);/);
    assert.ok(adoptionBatch, 'canonical adoption must declare a chunk size');
    assert.ok(
      Number(adoptionBatch[1]) * 2 <= 1000,
      `ADOPTION_BATCH_SIZE ${adoptionBatch[1]} issues ${Number(adoptionBatch[1]) * 2} commands per call, over the 1000-command budget STORY_BATCH_SIZE is sized against`,
    );
    assert.match(
      src,
      /offset \+= ADOPTION_BATCH_SIZE/,
      'the adoption read must stride by ADOPTION_BATCH_SIZE, not read every hash in one call',
    );
    assert.match(
      src,
      /lastSeen < freshnessCutoff/,
      'a track outside the digest freshness floor must not be adopted — it is ageing out and the story would re-fork',
    );
  });
});
