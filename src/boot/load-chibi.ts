import { CHIBI_REGIONS } from './theme';
import { brightnessOf, shadeHex, type CharGrid, type Cell } from './grid';

/** "Chibi Winking ASCII Art", its underline, and the blank line after it. */
export const HEADER_LINES = 3;

/** The file carries no colour, so hue comes from region masks and lightness
 *  from the ramp: dense glyph -> dark cell. The black dress is simply the
 *  densest region in the file, so it falls out of the ramp for free. */
export function parseChibi(text: string): CharGrid {
  const lines = text.replace(/\r\n/g, '\n').split('\n').slice(HEADER_LINES);
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();

  const rows = lines.length;
  const cols = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const cells: Cell[][] = [];

  for (let row = 0; row < rows; row++) {
    const line = lines[row]!;
    const v = rows > 1 ? row / (rows - 1) : 0;
    const out: Cell[] = [];

    for (let col = 0; col < cols; col++) {
      const ch = line[col] ?? ' ';
      const u = cols > 1 ? col / (cols - 1) : 0;
      const region = CHIBI_REGIONS.find((r) => r.test(u, v)) ?? CHIBI_REGIONS[CHIBI_REGIONS.length - 1]!;
      out.push({ ch, color: shadeHex(region.tint, brightnessOf(ch)) });
    }
    cells.push(out);
  }

  return { cols, rows, cells };
}
