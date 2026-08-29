import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseChibi } from './load-chibi';

const real = () => readFileSync('public/art/chibi_winking_ascii.txt', 'utf8');

describe('parseChibi', () => {
  it('strips the title and rule lines so the art starts at row 0', () => {
    const grid = parseChibi('Chibi Winking ASCII Art\n=======\n\n@@@\n@@@\n');
    expect(grid.rows).toBe(2);
    expect(grid.cells[0]!.map((c) => c.ch).join('')).toBe('@@@');
  });

  it('pads short lines so every row is the same width', () => {
    const grid = parseChibi('t\n=\n\n@@@@@\n@@\n');
    expect(grid.cols).toBe(5);
    expect(grid.cells[1]).toHaveLength(5);
    expect(grid.cells[1]![4]!.ch).toBe(' ');
  });

  it('renders the real artwork at the expected size', () => {
    const grid = parseChibi(real());
    expect(grid.cols).toBe(190);
    expect(grid.rows).toBeGreaterThan(80);
  });

  it('renders dense background glyphs near-black', () => {
    const grid = parseChibi(real());
    const corner = grid.cells[0]![0]!;
    expect(corner.ch).toBe('@');
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(corner.color.slice(i, i + 2), 16));
    expect(Math.max(r!, g!, b!)).toBeLessThan(24);
  });

  it('renders the dress darker than the face without needing a dress mask', () => {
    // This holds because of the ARTWORK, not a region mask: the dress is the
    // densest part of the file and dense means dark. If someone re-adds a
    // dress mask to "fix" the colour, this test will still pass — so read
    // CHIBI_REGIONS' comment before concluding a mask is what does this.
    const grid = parseChibi(real());
    const lum = (hex: string) =>
      [1, 3, 5].reduce((s, i) => s + parseInt(hex.slice(i, i + 2), 16), 0);
    const rowAt = (v: number) => grid.cells[Math.floor(grid.rows * v)]!;
    const mid = Math.floor(grid.cols * 0.45);
    expect(lum(rowAt(0.8)[mid]!.color)).toBeLessThan(lum(rowAt(0.45)[mid]!.color));
  });
});
