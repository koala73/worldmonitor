/**
 * WCAG relative luminance of a solid hex color (#rgb or #rrggbb, with or
 * without the leading '#'). https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const channel = (offset: number): number => {
    const c = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio between two solid hex colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Pick the higher-contrast foreground text color (white or near-black) for a
 * solid hex background. Returns whichever of `#ffffff` / `#1a1a1a` has the
 * greater contrast ratio against `bgHex` — e.g. white on dark badges, dark on
 * light/mid badges (yellow, orange). The four CorrelationPanel score-badge
 * backgrounds clear WCAG AA with the chosen color; arbitrary mid-gray inputs
 * may still need a different palette to reach 4.5:1.
 */
export function readableTextColor(bgHex: string): '#ffffff' | '#1a1a1a' {
  return contrastRatio('#ffffff', bgHex) >= contrastRatio('#1a1a1a', bgHex)
    ? '#ffffff'
    : '#1a1a1a';
}
