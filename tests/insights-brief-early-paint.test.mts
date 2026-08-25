import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// #4890: `#insightsContent .insights-brief-text` is the field LCP element in
// ~1/3 of desktop views (DebugBear lcpSelector, p75 4344ms) because the World
// Brief only paints after clusters + hydration + sentiment complete. For
// repeat visitors the previous brief is already in the persistent cache, so
// the panel must paint it at construction time (shell paint, ~600ms) and let
// the first real update pass overwrite it. InsightsPanel is DOM-heavy, so this
// suite keeps a focused source guard for the paint-order contract.
const source = readFileSync(new URL('../src/components/InsightsPanel.ts', import.meta.url), 'utf8');

const sliceBetween = (start: string, end: string): string => {
  const startIdx = source.indexOf(start);
  assert.notEqual(startIdx, -1, `slice start not found: ${start}`);
  const endIdx = source.indexOf(end, startIdx);
  assert.notEqual(endIdx, -1, `slice end not found: ${end}`);
  return source.slice(startIdx, endIdx);
};

describe('InsightsPanel early cached-brief paint (#4890)', () => {
  it('kicks the early cached-brief paint from the constructor', () => {
    const ctor = sliceBetween('constructor()', 'public setMilitaryFlights');
    assert.match(
      ctor,
      /void this\.paintCachedBriefEarly\(\);/,
      'the constructor must start the early cached-brief paint so the LCP text can land with the shell',
    );
  });

  it('guards the early paint against racing a real update on both sides of the await', () => {
    const method = sliceBetween('private async paintCachedBriefEarly()', 'private extractISQInput');
    assert.match(
      method,
      /if \(this\.updateGeneration > 0\) return;[\s\S]*?await this\.loadBriefFromCache\(\)/,
      'must bail before the cache read when a real update already started',
    );
    assert.match(
      method,
      /await this\.loadBriefFromCache\(\);\s*if \(this\.updateGeneration > 0\) return;/,
      'must re-check updateGeneration AFTER the async cache read — updateInsights() may have started during the await',
    );
    assert.match(
      method,
      /this\.setDataBadge\('cached'\);/,
      'the early paint is stale-by-definition content and must carry the cached badge',
    );
    assert.match(
      method,
      /this\.renderWorldBrief\(brief, sources\)/,
      'the early paint must reuse renderWorldBrief (it formats and links the cached summary)',
    );
  });

  // #7118: the cache-only early paint helped repeat visitors and did nothing
  // on a cold visit, so the brief still became the field LCP element at
  // p75 ~3.5s (#7113). Behavioural coverage lives in
  // tests/dom/insights-brief-cold-early-paint.test.mts; this pins the ordering
  // contract the DOM test cannot see — that the cache is tried FIRST and the
  // bootstrap read only happens on a miss.
  it('falls back to the hydrated bootstrap brief only after the cache misses (#7118)', () => {
    const method = sliceBetween('private async paintCachedBriefEarly()', 'private extractISQInput');
    assert.match(
      method,
      /await this\.loadBriefFromCache\(\);[\s\S]*?if \(!brief\) \{[\s\S]*?getServerInsights\(\)/,
      'the bootstrap read must sit behind the cache miss — the cache is the cheaper path and #4890 owns it',
    );
    assert.match(
      method,
      /sources = InsightsPanel\.serverBriefSources\(server\)/,
      'the server fallback must use the shared citation bound, not a fresh literal that can drift from renderServerInsights',
    );
  });

  it('does not hold the server brief behind the sentiment worker (#7118)', () => {
    const method = sliceBetween('private async updateFromServer(', 'private async updateFromClient(');
    const paintIdx = method.indexOf("#7118 pre-sentiment paint");
    const sentimentIdx = method.indexOf('await mlWorker.classifySentiment');
    assert.notEqual(paintIdx, -1, 'updateFromServer must paint the brief before classifying sentiment');
    assert.notEqual(sentimentIdx, -1, 'slice must still contain the sentiment await');
    assert.ok(
      paintIdx < sentimentIdx,
      'the brief paint must come BEFORE the sentiment await — classifySentiment can cost seconds while the ONNX model loads',
    );
  });

  it('server-insights renders persist the brief so the NEXT boot has something to early-paint', () => {
    const method = sliceBetween('private renderServerInsights(', 'private renderServerStories(');
    assert.match(
      method,
      /setPersistentCache\(InsightsPanel\.BRIEF_CACHE_KEY, \{ summary: insights\.worldBrief, sources: this\.cachedBriefSources \}\)/,
      'the server path must write the persistent brief cache — before #4890 only the client-LLM fallback wrote it, so repeat visitors on the dominant server path had an empty cache',
    );
    assert.doesNotMatch(
      method,
      /worldBriefSources\.slice\(0,\s*6\)/,
      '#4928: the server brief cites up to 12 sources — re-capping the persisted list at 6 orphans [7]/[8] citations in the early paint (Greptile P1 on PR #5130)',
    );
  });

  it('reads the cached brief with the citation-space bound, not the legacy 6 cap', () => {
    const method = sliceBetween('private async loadBriefFromCache()', 'private async paintCachedBriefEarly()');
    assert.match(
      method,
      /normalizeCachedBriefSources\(entry\.data, InsightsPanel\.BRIEF_CACHE_MAX_SOURCES\)/,
      'the cache read must use the shared 12-source citation bound — a literal 6 re-orphans [7]/[8] on the early paint and client cooldown renders',
    );
  });
});
