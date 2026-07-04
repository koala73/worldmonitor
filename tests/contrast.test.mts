import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readableTextColor, contrastRatio, relativeLuminance } from '../src/utils/contrast.ts';

describe('contrast util', () => {
  it('computes WCAG contrast ratio at the extremes', () => {
    assert.equal(Math.round(contrastRatio('#ffffff', '#000000')), 21);
    assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  });

  it('parses 3-digit and #-less hex', () => {
    assert.equal(relativeLuminance('#fff'), relativeLuminance('#ffffff'));
    assert.equal(relativeLuminance('000'), relativeLuminance('#000000'));
  });

  it('picks white text only when it clears AA, else dark — for every correlation score color', () => {
    // The CorrelationPanel score-badge backgrounds (#4421 / #4418).
    const cases: Array<[string, '#ffffff' | '#1a1a1a']> = [
      ['#6f6f6f', '#ffffff'], // low (dark bg → white)
      ['#ff4444', '#1a1a1a'], // critical (white was 3.41 → dark)
      ['#ff8800', '#1a1a1a'], // high (white was 2.39 → dark)
      ['#ffcc00', '#1a1a1a'], // medium (white was 1.51 → dark)
    ];
    for (const [bg, expected] of cases) {
      const text = readableTextColor(bg);
      assert.equal(text, expected, `${bg} should use ${expected}`);
      // The chosen text color must actually clear WCAG AA (4.5:1) on that bg.
      assert.ok(
        contrastRatio(text, bg) >= 4.5,
        `${text} on ${bg} must be >= 4.5:1 (got ${contrastRatio(text, bg).toFixed(2)})`,
      );
    }
  });

  it('always returns the higher-contrast of white/dark', () => {
    for (const bg of ['#000000', '#ffffff', '#808080', '#123456', '#abcdef']) {
      const text = readableTextColor(bg);
      const other = text === '#ffffff' ? '#1a1a1a' : '#ffffff';
      assert.ok(contrastRatio(text, bg) >= contrastRatio(other, bg));
    }
  });
});
