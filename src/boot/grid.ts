/** The standard 70-glyph density ramp, sparse to dense. Both source artworks
 *  were rendered with it against a black background, so a dense glyph marks a
 *  DARK pixel — see brightnessOf. */
export const RAMP =
  ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';

export interface Cell {
  ch: string;
  /** Final rendered colour, already shaded by brightness. */
  color: string;
}

export interface CharGrid {
  cols: number;
  rows: number;
  cells: Cell[][];
}

const MAX_INDEX = RAMP.length - 1;

/** 0 = sparse (bright source pixel), 1 = dense (dark source pixel). */
export function densityOf(ch: string): number {
  const i = RAMP.indexOf(ch);
  return i < 0 ? 0 : i / MAX_INDEX;
}

/** Dense glyphs came from dark pixels, so they must render dark. Inverting
 *  this paints a glowing slab with the artwork punched out as a hole. */
export function brightnessOf(ch: string): number {
  return 1 - densityOf(ch);
}

/** Re-encode a source glyph for TERMINAL display.
 *
 *  The source artwork encodes tone as density where DENSE means DARK. A
 *  terminal, though, draws ink: `@` covers most of its cell, a space covers
 *  none. Drawing the source glyph therefore puts the most ink exactly where
 *  the picture is darkest and none where it is brightest — so the artwork
 *  renders inverted and mostly empty, with the character's lit face appearing
 *  as blank space and the black background as the only visible texture.
 *
 *  Displaying it correctly means choosing the glyph whose INK COVERAGE matches
 *  the intended brightness. Both ramps have the same 70 steps, so the tone is
 *  preserved exactly — only which glyph carries it changes.
 *
 *  This is a rendering concern, not a data one: CharGrid keeps the source
 *  glyphs, and only the typewriter re-encodes on the way to the DOM. */
export function displayGlyphFor(ch: string): string {
  return RAMP[Math.round(brightnessOf(ch) * MAX_INDEX)] ?? ' ';
}

export function shadeHex(hex: string, brightness: number): string {
  const b = Math.max(0, Math.min(1, brightness));
  const n = parseInt(hex.slice(1), 16);
  const scale = (v: number) => Math.round(v * b).toString(16).padStart(2, '0');
  return `#${scale((n >> 16) & 255)}${scale((n >> 8) & 255)}${scale(n & 255)}`;
}
