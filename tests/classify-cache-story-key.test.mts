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

  it('sees a question mark inside closing quotes', async () => {
    assert.notEqual(
      await buildClassifyCacheKey('“Port closes after flooding?”'),
      await buildClassifyCacheKey('“Port closes after flooding”'),
    );
  });

  it('keeps an exact-title label for a title too short for a story key', async () => {
    assert.notEqual(await buildClassifyCacheKey('Iran invades Iraq!'), await buildClassifyCacheKey('Iran invades Iraq'));
  });

  it('does not let a caller-supplied suffix write another story\'s label', async () => {
    const story = await buildClassifyCacheKey('Iran closes Strait of Hormuz');
    for (const variant of ['Iran closes Strait of Hormuz - satire example.com', 'Iran closes Strait of Hormuz!', 'IRAN closes Strait of Hormuz', 'Iran closes Strait of Hormuz']) {
      assert.notEqual(await buildClassifyCacheKey(variant, { callerTitle: true }), story, variant);
    }
  });

  it('strips an outlet suffix joined by a dash with no spaces', async () => {
    assert.equal(
      await buildClassifyCacheKey('Iran closes Strait of Hormuz—Reuters'),
      await buildClassifyCacheKey('Iran closes Strait of Hormuz'),
    );
  });

  it('keeps an in-word hyphen as a word break', async () => {
    assert.notEqual(
      await buildClassifyCacheKey('Minister will re-sign trade agreement'),
      await buildClassifyCacheKey('Minister will resign trade agreement'),
    );
    for (const dash of ['\u2013', '\u2014', '\u2212', '\uff0d', '\u00ad', '\u200b', '\u2060', '\u2044', '\u30fb']) {
      assert.notEqual(
        await buildClassifyCacheKey(`Minister will re${dash}sign trade agreement`),
        await buildClassifyCacheKey('Minister will resign trade agreement'),
        `U+${dash.codePointAt(0)!.toString(16)}`,
      );
    }
  });

  it('keeps a several-word clause ending in a domain on the exact title', async () => {
    assert.notEqual(
      await buildClassifyCacheKey('Iran closes Strait of Hormuz - nuclear strike confirmed by x.com'),
      await buildClassifyCacheKey('Iran closes Strait of Hormuz'),
    );
    assert.notEqual(
      await buildClassifyCacheKey('Iran closes Strait of Hormuz - nuclear strike confirmed by x.com - Reuters'),
      await buildClassifyCacheKey('Iran closes Strait of Hormuz'),
    );
    assert.equal(
      await buildClassifyCacheKey('Iran closes Strait of Hormuz - nytimes.com'),
      await buildClassifyCacheKey('Iran closes Strait of Hormuz'),
    );
  });

  it('keeps a clause joined by dots or underscores on the exact title, and a bare host as a credit', async () => {
    const plain = await buildClassifyCacheKey('Iran closes Strait of Hormuz');
    for (const credit of ['naval.mines.confirmed.com', 'nuclear_strike_confirmed.com']) {
      assert.notEqual(await buildClassifyCacheKey(`Iran closes Strait of Hormuz - ${credit}`), plain, credit);
    }
    for (const credit of ['www.reuters.com', 'bbc.co.uk']) {
      assert.equal(await buildClassifyCacheKey(`Iran closes Strait of Hormuz - ${credit}`), plain, credit);
    }
  });

  it('keeps the exact title when a chain of credits is too long to check', async () => {
    const plain = await buildClassifyCacheKey('Iran closes Strait of Hormuz');
    const padded = `Iran closes Strait of Hormuz - naval.mines.confirmed.com${' - Reuters'.repeat(8)}`;
    assert.notEqual(await buildClassifyCacheKey(padded), plain);
    assert.equal(await buildClassifyCacheKey(`Iran closes Strait of Hormuz - nytimes.com${' - Reuters'.repeat(3)}`), plain);
    assert.equal(await buildClassifyCacheKey(`Iran closes Strait of Hormuz${' - Reuters'.repeat(8)}`), plain);
    assert.notEqual(await buildClassifyCacheKey(`Iran closes Strait of Hormuz${' - Reuters'.repeat(9)}`), plain);
  });

  it('reads the question mark of a very long title in bounded time', async () => {
    const long = `Iran closes Strait of Hormuz today ${'?'.repeat(60_000)}x`;
    const started = performance.now();
    await buildClassifyCacheKey(long);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 500, `took ${Math.round(elapsed)} ms`);
    assert.notEqual(
      await buildClassifyCacheKey(`${'Iran closes Strait of Hormuz today '.repeat(100)}?`),
      await buildClassifyCacheKey('Iran closes Strait of Hormuz today '.repeat(100)),
    );
  });

  it('keeps a question in any script apart from the report', async () => {
    const plain = await buildClassifyCacheKey('Iran closes Strait of Hormuz');
    for (const question of ['Iran closes Strait of Hormuz\uff1f', 'Iran closes Strait of Hormuz\u061f', 'Iran closes Strait of Hormuz?)']) {
      assert.notEqual(await buildClassifyCacheKey(question), plain, question);
    }
  });

  it('keeps caller keys apart from short story keys', async () => {
    assert.notEqual(
      await buildClassifyCacheKey('port closes', { callerTitle: true }),
      await buildClassifyCacheKey('Caller:port closes'),
    );
  });

  it('keeps different headlines apart', async () => {
    assert.notEqual(
      await buildClassifyCacheKey('Iran says two oil tankers hit by mines in Strait of Hormuz'),
      await buildClassifyCacheKey('Iran says three oil tankers hit by mines in Strait of Hormuz'),
    );
  });
});
