import { RAMP, shadeHex, type CharGrid, type Cell } from './grid';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

/** Terminal cells are about twice as tall as they are wide, so a square image
 *  needs roughly half as many rows as columns to keep its proportions. */
export const CHAR_ASPECT = 0.5;

const MAX_INDEX = RAMP.length - 1;

export function decompose(img: RgbaImage, cols: number): CharGrid {
  const rows = Math.max(1, Math.round((img.height / img.width) * cols * CHAR_ASPECT));
  const cells: Cell[][] = [];

  for (let row = 0; row < rows; row++) {
    const line: Cell[] = [];
    const y0 = Math.floor((row * img.height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * img.height) / rows));

    for (let col = 0; col < cols; col++) {
      const x0 = Math.floor((col * img.width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((col + 1) * img.width) / cols));

      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * img.width + x) * 4;
          r += img.data[i] ?? 0;
          g += img.data[i + 1] ?? 0;
          b += img.data[i + 2] ?? 0;
          n++;
        }
      }
      r /= n; g /= n; b /= n;

      // Rec. 601 luma, then invert: a dark block gets a dense glyph.
      const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const ch = RAMP[Math.round((1 - luma) * MAX_INDEX)] ?? ' ';

      // Preserve hue at full strength; the glyph already encodes lightness,
      // so shading by luma as well would wash the art out.
      const hex = `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
      line.push({ ch, color: shadeHex(hex, 1) });
    }
    cells.push(line);
  }

  return { cols, rows, cells };
}
