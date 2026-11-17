import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { truncateForDisplay } from '../shared/brief-text.js';

const graphemes = (s) => Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)).length;
const legacy = (s, max) => (s.length > max ? s.slice(0, max).replace(/\s+\S*$/, '') + '…' : s);

describe('truncateForDisplay', () => {
  it('returns short text unchanged', () => {
    assert.equal(truncateForDisplay('Short line.', 200), 'Short line.');
    assert.equal(truncateForDisplay('', 10), '');
  });

  it('cuts English at a word boundary and appends an ellipsis', () => {
    assert.equal(truncateForDisplay('The quick brown fox jumps', 12), 'The quick…');
    const long = 'Tehran signalled that commercial shipping can keep moving through Hormuz, but tanker premiums remain elevated as insurers reprice Gulf transit risk and war-risk cover tightens across the region today.';
    for (const max of [20, 57, 100, 150, 199]) assert.equal(truncateForDisplay(long, max, 'en'), legacy(long, max), String(max));
  });

  it('cuts Japanese and Thai at a segmenter word boundary, not mid-word', () => {
    const ja = '東京証券取引所は本日、半導体関連株の急落を受けて取引を一時停止したと発表した。';
    const jaWords = Array.from(new Intl.Segmenter('ja', { granularity: 'word' }).segment(ja)).map((s) => s.index);
    const jaOut = truncateForDisplay(ja, 15, 'ja');
    assert.ok(jaOut.endsWith('…'));
    assert.ok(jaWords.includes(jaOut.length - 1), jaOut);
    const th = 'ธนาคารแห่งประเทศไทยประกาศคงอัตราดอกเบี้ยนโยบายไว้ที่ระดับเดิม';
    const thWords = Array.from(new Intl.Segmenter('th', { granularity: 'word' }).segment(th)).map((s) => s.index);
    const thOut = truncateForDisplay(th, 20, 'th');
    assert.ok(thWords.includes(thOut.length - 1), thOut);
  });

  it('never splits a surrogate pair or a combining sequence', () => {
    const emoji = '😀'.repeat(10);
    const out = truncateForDisplay(emoji, 5);
    assert.equal(out, `${'😀'.repeat(5)}…`);
    const combining = 'e\u0301'.repeat(8);
    assert.equal(truncateForDisplay(combining, 3), `${'e\u0301'.repeat(3)}…`);
    const hindi = 'प्रधानमंत्री ने संसद में नई नीति की घोषणा की';
    const hi = truncateForDisplay(hindi, 9, 'hi');
    const clusters = (s) => Array.from(new Intl.Segmenter('hi', { granularity: 'grapheme' }).segment(s), (x) => x.segment);
    const head = clusters(hi.slice(0, -1));
    assert.deepEqual(head, clusters(hindi).slice(0, head.length));
  });

  it('a stray space does not send unspaced scripts down the word-drop path', () => {
    const zh = `Google 发布${'新的人工智能模型并宣布扩展云服务'.repeat(15)}`;
    const cut = truncateForDisplay(zh, 200, 'zh');
    assert.ok(graphemes(cut) > 150, `kept ${graphemes(cut)} clusters: ${cut}`);
    assert.ok(cut.startsWith('Google 发布'));
    assert.ok(cut.endsWith('…'));
  });

  it('counts grapheme clusters, not UTF-16 units', () => {
    const flags = '🇫🇷🇩🇪🇪🇸🇮🇹';
    assert.equal(truncateForDisplay(flags, 4), flags);
    assert.equal(graphemes(truncateForDisplay(flags, 2)), 3);
  });

  it('falls back to a code-point slice when Intl.Segmenter is missing', () => {
    const original = Intl.Segmenter;
    try {
      // @ts-ignore
      delete Intl.Segmenter;
      assert.equal(truncateForDisplay('😀😀😀😀', 2), '😀😀…');
      assert.equal(truncateForDisplay('abc', 5), 'abc');
    } finally {
      Intl.Segmenter = original;
    }
  });
});
