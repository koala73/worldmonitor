import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { RAMP, brightnessOf, densityOf, displayGlyphFor, shadeHex } from './grid';

describe('density ramp', () => {
  it('covers every glyph the real artwork actually uses', () => {
    // An unmapped glyph is not an error — densityOf returns 0, i.e. the
    // BRIGHTEST value — so a ramp that missed a character would silently
    // punch holes in the art rather than fail. This pins the coverage.
    //
    // The first three lines are the file's title, its underline and a blank,
    // which the loader strips; they contain 'A', 'S', 'g' and '=' that the
    // artwork itself never uses. Scanning them would report false gaps.
    const body = readFileSync('public/art/chibi_winking_ascii.txt', 'utf8')
      .split('\n')
      .slice(3)
      .join('');
    const missing = [...new Set(body)].filter((ch) => ch !== '\n' && RAMP.indexOf(ch) < 0);
    expect(missing).toEqual([]);
  });

  it('has 70 glyphs running sparse to dense', () => {
    expect(RAMP).toHaveLength(70);
    expect(RAMP[0]).toBe(' ');
    expect(RAMP.endsWith('$')).toBe(true);
  });

  it('treats dense glyphs as DARK — the whole art pipeline depends on it', () => {
    // '@' is the background fill of the source art and must render near-black.
    expect(densityOf('@')).toBeGreaterThan(0.95);
    expect(brightnessOf('@')).toBeLessThan(0.05);
    // ' ' is the brightest part of the source image.
    expect(brightnessOf(' ')).toBe(1);
  });

  it('increases density monotonically along the ramp', () => {
    for (let i = 1; i < RAMP.length; i++) {
      expect(densityOf(RAMP[i]!)).toBeGreaterThan(densityOf(RAMP[i - 1]!));
    }
  });

  it('treats unknown glyphs as empty rather than throwing', () => {
    expect(densityOf('é')).toBe(0);
  });

  it('re-encodes glyphs so INK COVERAGE carries the brightness', () => {
    // A terminal draws ink, so the source glyph would put the most ink where
    // the picture is DARKEST — the artwork renders inverted and mostly empty,
    // the lit face becoming blank space. The display glyph's density must
    // therefore match the source glyph's brightness.
    expect(densityOf(displayGlyphFor(' '))).toBeCloseTo(1, 5);  // brightest -> most ink
    expect(densityOf(displayGlyphFor('@'))).toBeLessThan(0.05); // darkest -> almost none
    for (const ch of RAMP) {
      expect(densityOf(displayGlyphFor(ch))).toBeCloseTo(brightnessOf(ch), 1);
    }
  });

  it('scales a hex colour by brightness', () => {
    expect(shadeHex('#ffffff', 1)).toBe('#ffffff');
    expect(shadeHex('#ffffff', 0)).toBe('#000000');
    expect(shadeHex('#ff0000', 0.5)).toBe('#800000');
  });
});
