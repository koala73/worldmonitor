import { describe, it, expect } from 'vitest';
import { CHAR_ASPECT, decompose, type RgbaImage } from './ascii-decomposer';
import { densityOf } from './grid';

/** Solid-colour test image — no art files, so tests stay fast and independent. */
function solid(width: number, height: number, r: number, g: number, b: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

describe('decompose', () => {
  it('maps a black image to the densest glyph, because black is dense', () => {
    const grid = decompose(solid(40, 40, 0, 0, 0), 10);
    expect(densityOf(grid.cells[0]![0]!.ch)).toBe(1);
  });

  it('maps a white image to the sparsest glyph', () => {
    const grid = decompose(solid(40, 40, 255, 255, 255), 10);
    expect(densityOf(grid.cells[0]![0]!.ch)).toBe(0);
  });

  it('produces the requested column count', () => {
    const grid = decompose(solid(100, 50, 128, 128, 128), 25);
    expect(grid.cols).toBe(25);
    expect(grid.cells[0]).toHaveLength(25);
  });

  it('compensates for non-square character cells when choosing row count', () => {
    // A square image must not become a square grid: cells are taller than wide.
    const grid = decompose(solid(100, 100, 128, 128, 128), 100);
    expect(grid.rows).toBe(Math.round(100 * CHAR_ASPECT));
    expect(grid.rows).toBeLessThan(grid.cols);
  });

  it('carries source colour through to the cell', () => {
    const grid = decompose(solid(20, 20, 200, 0, 0), 5);
    expect(grid.cells[0]![0]!.color).toMatch(/^#[0-9a-f]{6}$/);
    const c = grid.cells[0]![0]!.color;
    // red channel dominates
    expect(parseInt(c.slice(1, 3), 16)).toBeGreaterThan(parseInt(c.slice(3, 5), 16));
  });
});
