import type { MapLayers } from '@/types';
import { DECK_POINT_LAYER_CATEGORY, categoryGlyphForLayer } from '@/config/map-layer-glyphs';

export interface CategoryGlyphAtlas {
  /** PNG data URL holding one badge cell per category. */
  url: string;
  mapping: Record<string, { x: number; y: number; width: number; height: number; anchorY: number; mask: false }>;
}

const CELL = 64;
const COLUMNS = 8;
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';

let cached: CategoryGlyphAtlas | null | undefined;

/**
 * One canvas atlas with a badge per map-layer category: the Layers-menu emoji
 * on a dark disc with a light rim, so it reads on dark and light basemaps.
 * Built once on first use; every glyph layer shares it, so markers cost one
 * GPU instance each instead of a DOM node.
 */
export function getCategoryGlyphAtlas(): CategoryGlyphAtlas | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (typeof document === 'undefined') return cached;

  const keys = [...new Set(Object.values(DECK_POINT_LAYER_CATEGORY))] as Array<keyof MapLayers>;
  const rows = Math.ceil(keys.length / COLUMNS);
  const canvas = document.createElement('canvas');
  canvas.width = CELL * COLUMNS;
  canvas.height = CELL * rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) return cached;

  const mapping: CategoryGlyphAtlas['mapping'] = {};
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(CELL * 0.56)}px ${EMOJI_FONT}`;
  keys.forEach((key, index) => {
    const x = (index % COLUMNS) * CELL;
    const y = Math.floor(index / COLUMNS) * CELL;
    const cx = x + CELL / 2;
    const cy = y + CELL / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, CELL / 2 - 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(12, 16, 24, 0.86)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    // Emoji fonts sit slightly high on the middle baseline; nudge to centre.
    ctx.fillText(categoryGlyphForLayer(key), cx, cy + CELL * 0.04);
    mapping[key] = { x, y, width: CELL, height: CELL, anchorY: CELL / 2, mask: false };
  });

  try {
    cached = { url: canvas.toDataURL('image/png'), mapping };
  } catch {
    cached = null;
  }
  return cached;
}
