import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripAttributionSuffix } from '../shared/story-identity.js';
import { classifyEphemeralLiveCoverage } from '../shared/ephemeral-live-classifier.js';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest.ts';

const { normalizeTitle } = __testing__;
const FAST_MS = 50;

describe('attribution suffix bounds', () => {
  it('strips ordinary publisher and domain suffixes', () => {
    assert.equal(stripAttributionSuffix('Iran threatens Hormuz - Reuters'), 'Iran threatens Hormuz');
    assert.equal(stripAttributionSuffix('Iran threatens Hormuz - example.com'), 'Iran threatens Hormuz');
    assert.equal(stripAttributionSuffix('Iran threatens Hormuz | BBC'), 'Iran threatens Hormuz');
    assert.equal(
      stripAttributionSuffix(`Iran threatens Hormuz${' '.repeat(80)}- Reuters`),
      'Iran threatens Hormuz',
    );
    assert.equal(stripAttributionSuffix('Iran-Iraq talks resume'), 'Iran-Iraq talks resume');
  });

  it('finishes a 100k whitespace title and a repeated "- a" title quickly', () => {
    const spaced = `Iran threatens Hormuz${' '.repeat(100_000)}`;
    const repeated = '- a'.repeat(33_334);
    const started = performance.now();
    assert.equal(stripAttributionSuffix(spaced), spaced);
    assert.equal(stripAttributionSuffix(repeated), repeated);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < FAST_MS, `stripAttributionSuffix took ${elapsed.toFixed(1)}ms`);
  });

  it('keeps normalizeTitle output for ordinary headlines and bounds a long title', () => {
    assert.equal(normalizeTitle('Iran threatens Hormuz - Reuters'), 'iran threatens hormuz');
    assert.equal(normalizeTitle('Foo | Reuters'), 'foo reuters');
    assert.equal(normalizeTitle('Hello, world'), 'hello world');
    const repeated = '- a'.repeat(33_334);
    const started = performance.now();
    assert.equal(normalizeTitle(' '.repeat(100_000)), '');
    assert.equal(normalizeTitle(repeated), 'a '.repeat(60));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < FAST_MS, `normalizeTitle took ${elapsed.toFixed(1)}ms`);
  });

  it('classifies ordinary live teasers and bounds a whitespace title', () => {
    assert.equal(classifyEphemeralLiveCoverage({ title: 'Watch: Press conference live' }), true);
    assert.equal(classifyEphemeralLiveCoverage({ title: 'Watch: tornadoes swirl through Oklahoma' }), false);
    assert.equal(
      classifyEphemeralLiveCoverage({ title: `watch:${' '.repeat(40)}live briefing` }),
      true,
    );
    const started = performance.now();
    assert.equal(
      classifyEphemeralLiveCoverage({ title: `watch:${' '.repeat(100_000)}x` }),
      false,
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed < FAST_MS, `live classifier took ${elapsed.toFixed(1)}ms`);
  });
});
