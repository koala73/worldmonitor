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
    // A stacked run of breaks is one break, and so is any other joiner.
    for (const run of ['\u00ad\u200b', '--', '\u2060\u2013', '/', '\u00b7', '\u2027', '+', '_', '\u2022']) {
      assert.notEqual(
        await buildClassifyCacheKey(`Minister will re${run}sign trade agreement`),
        await buildClassifyCacheKey('Minister will resign trade agreement'),
        JSON.stringify(run),
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
    for (const credit of ['naval.mines.confirmed.com', 'mines.confirmed.com', 'nuclear_strike_confirmed.com']) {
      assert.notEqual(await buildClassifyCacheKey(`Iran closes Strait of Hormuz - ${credit}`), plain, credit);
    }
    for (const credit of ['reuters.com', 'www.reuters.com', 'bbc.co.uk']) {
      assert.equal(await buildClassifyCacheKey(`Iran closes Strait of Hormuz - ${credit}`), plain, credit);
    }
  });

  it('keeps an apostrophe inside its word', async () => {
    assert.equal(
      await buildClassifyCacheKey("UAE's ADNOC says crew member missing after attack"),
      await buildClassifyCacheKey('UAE\u2019s ADNOC says crew member missing after attack - Reuters'),
    );
  });

  it('keeps a headline whose marks carry meaning on its exact title, and composes a decomposed accent', async () => {
    // Shadda: "teacher" and "school" differ only by the mark.
    assert.notEqual(
      await buildClassifyCacheKey('قصف مدرّسة في غزة اليوم صباحا'),
      await buildClassifyCacheKey('قصف مدرسة في غزة اليوم صباحا'),
    );
    // NFD and NFC spell the same word, which is not the unaccented one.
    const nfc = 'Protesters storm Bogotá city hall overnight';
    assert.equal(await buildClassifyCacheKey(nfc.normalize('NFD')), await buildClassifyCacheKey(nfc));
    assert.notEqual(await buildClassifyCacheKey(nfc), await buildClassifyCacheKey('Protesters storm Bogota city hall overnight'));
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

  it('keeps a padded question apart from the padded report', async () => {
    // Past the story scan the key drops the tail, where the question mark sits.
    const pad = `${' '.repeat(2_500)}more`;
    assert.notEqual(
      await buildClassifyCacheKey(`Iran closes Strait of Hormuz?${pad}`),
      await buildClassifyCacheKey(`Iran closes Strait of Hormuz${pad}`),
    );
    // Whitespace that goes with a stripped credit must not push the '?' out either.
    const gap = `${' '.repeat(2_100)}- Reuters`;
    assert.notEqual(
      await buildClassifyCacheKey(`Iran closes Strait of Hormuz?${gap}`),
      await buildClassifyCacheKey(`Iran closes Strait of Hormuz${gap}`),
    );
    assert.notEqual(
      await buildClassifyCacheKey('Iran closes Strait of Hormuz? - Reuters'),
      await buildClassifyCacheKey('Iran closes Strait of Hormuz - Reuters'),
    );
  });

  it('keeps a question in any script apart from the report', async () => {
    const plain = await buildClassifyCacheKey('Iran closes Strait of Hormuz');
    for (const question of ['Iran closes Strait of Hormuz\uff1f', 'Iran closes Strait of Hormuz\u061f', 'Iran closes Strait of Hormuz?)', 'Iran closes Strait of Hormuz\u203d']) {
      assert.notEqual(await buildClassifyCacheKey(question), plain, question);
    }
    // Greek asks with the erotimatiko, written ';' or U+037E.
    const greek = '\u03a4\u03bf \u0399\u03c1\u03ac\u03bd \u03b5\u03c0\u03b9\u03c4\u03ad\u03b8\u03b7\u03ba\u03b5 \u03c3\u03c4\u03bf \u03b4\u03b5\u03be\u03b1\u03bc\u03b5\u03bd\u03cc\u03c0\u03bb\u03bf\u03b9\u03bf';
    for (const mark of [';', '\u037e']) {
      assert.notEqual(await buildClassifyCacheKey(greek + mark), await buildClassifyCacheKey(greek), mark);
    }
  });

  it('reads a dotted abbreviation as one word', async () => {
    assert.equal(
      await buildClassifyCacheKey('U.S. says Iran closes Strait of Hormuz'),
      await buildClassifyCacheKey('US says Iran closes Strait of Hormuz'),
    );
    assert.equal(
      await buildClassifyCacheKey('U.S.-Iran talks collapse over Strait of Hormuz'),
      await buildClassifyCacheKey('US-Iran talks collapse over Strait of Hormuz'),
    );
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
