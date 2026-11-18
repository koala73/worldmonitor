import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildClassifyCacheKey } from '../server/worldmonitor/intelligence/v1/_shared.ts';

describe('classify cache key is the story, not the title string (#10976)', () => {
  it('gives one label to the same headline with and without an outlet suffix or punctuation', async () => {
    assert.equal(
      await buildClassifyCacheKey("UAE's ADNOC L&S says one crew member missing after attack on its vessel in Hormuz - Reuters"),
      await buildClassifyCacheKey("UAE's ADNOC L&S says one crew member missing after attack on its vessel in Hormuz"),
    );
    assert.equal(
      await buildClassifyCacheKey('ADNOC says one of its vessels attacked in Strait of Hormuz'),
      await buildClassifyCacheKey('ADNOC Says One of Its Vessels Attacked in Strait of Hormuz!'),
    );
  });

  it('keeps a question apart from the report it asks about', async () => {
    assert.notEqual(
      await buildClassifyCacheKey('Iran closes Strait of Hormuz?'),
      await buildClassifyCacheKey('Iran closes Strait of Hormuz'),
    );
    assert.equal(
      await buildClassifyCacheKey('Iran closes Strait of Hormuz? - Reuters'),
      await buildClassifyCacheKey('Iran closes Strait of Hormuz?'),
    );
  });

  it('does not let a caller-supplied suffix write another story\'s label', async () => {
    const story = await buildClassifyCacheKey('Iran closes Strait of Hormuz');
    assert.notEqual(await buildClassifyCacheKey('Iran closes Strait of Hormuz - satire example.com', { callerTitle: true }), story);
    assert.equal(await buildClassifyCacheKey('Iran closes Strait of Hormuz', { callerTitle: true }), story);
  });

  it('keeps different headlines apart', async () => {
    assert.notEqual(
      await buildClassifyCacheKey('Iran says two oil tankers hit by mines in Strait of Hormuz'),
      await buildClassifyCacheKey('Iran says three oil tankers hit by mines in Strait of Hormuz'),
    );
  });
});
