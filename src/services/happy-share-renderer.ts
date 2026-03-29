/**
 * Canvas 2D renderer for branded happy story share cards.
 * Generates a 1080x1080 PNG from a NewsItem with warm gradient,
 * category badge, headline, source, date, and HappyMonitor watermark.
 */
import type { NewsItem } from '@/types';
import type { HappyContentCategory } from '@/services/positive-classifier';
import { HAPPY_CATEGORY_LABELS } from '@/services/positive-classifier';

const SIZE = 1080;
const PAD = 80;
const CONTENT_W = SIZE - PAD * 2;

/** Category-specific gradient stops (light, warm palettes) */
const CATEGORY_GRADIENTS: Record<HappyContentCategory, [string, string]> = {
  'science-health': ['#E8F4FD', '#C5DFF8'],
  'nature-wildlife': ['#E8F5E4', '#C5E8BE'],
  'humanity-kindness': ['#FDE8EE', '#F5C5D5'],
  'innovation-tech': ['#FDF5E8', '#F5E2C0'],
  'climate-wins': ['#E4F5E8', '#BEE8C5'],
  'culture-community': ['#F0E8FD', '#D8C5F5'],
};

/** Category accent colors for badges and decorative line */
const CATEGORY_ACCENTS: Record<HappyContentCategory, string> = {
  'science-health': '#7BA5C4',
  'nature-wildlife': '#6B8F5E',
  'humanity-kindness': '#C48B9F',
  'innovation-tech': '#C4A35A',
  'climate-wins': '#2d9a4e',
  'culture-community': '#8b5cf6',
};

const DEFAULT_CATEGORY: HappyContentCategory = 'humanity-kindness';

/**
 * Word-wrap helper: splits text into lines that fit within maxWidth.
 * Canvas 2D has no auto-wrap, so we measure word-by-word.
 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines;
}

/**
 * Draw a rounded rectangle path (does not fill/stroke -- caller does that).
 */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Render a branded 1080x1080 share card from a NewsItem.
 * Text-only (no images) to avoid cross-origin canvas tainting.
 */
export async function renderHappyShareCard(item: NewsItem): Promise<HTMLCanvasElement> {
  // Ensure Nunito fonts are loaded before rendering
  await Promise.all([
    document.fonts.load('700 48px Nunito'),
    document.fonts.load('400 26px Nunito'),
  ]).catch(() => { /* proceed with system font fallback if fonts fail */ });

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;

  const category: HappyContentCategory = item.happyCategory || DEFAULT_CATEGORY;
  const [gradStart, gradEnd] = CATEGORY_GRADIENTS[category];
  const accent = CATEGORY_ACCENTS[category];

  // -- Background gradient --
  const grad = ctx.createLinearGradient(0, 0, 0, SIZE);
  grad.addColorStop(0, gradStart);
  grad.addColorStop(1, gradEnd);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  let y = PAD;

  // -- Category badge (pill shape, top-left) --
  const categoryLabel = HAPPY_CATEGORY_LABELS[category];
  ctx.font = '700 24px Nunito, system-ui, sans-serif';
  const badgeTextW = ctx.measureText(categoryLabel).width;
  const badgePadX = 16;
  const badgePadY = 6;
  const badgeW = badgeTextW + badgePadX * 2;
  const badgeH = 36;

  ctx.fillStyle = accent;
  roundRect(ctx, PAD, y, badgeW, badgeH, badgeH / 2);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(categoryLabel, PAD + badgePadX, y + badgeH - badgePadY - 4);

  y += badgeH + 48;

  // -- Headline text (word-wrapped, max ~6 lines) --
  ctx.font = '700 48px Nunito, system-ui, sans-serif';
  ctx.fillStyle = '#2D3748';
  const headlineLines = wrapText(ctx, item.title, CONTENT_W);
  const maxLines = 6;
  const displayLines = headlineLines.slice(0, maxLines);

  // If we truncated, add ellipsis to last line
  if (headlineLines.length > maxLines) {
    let lastLine = displayLines[maxLines - 1] ?? '';
    while (ctx.measureText(lastLine + '...').width > CONTENT_W && lastLine.length > 0) {
      lastLine = lastLine.slice(0, -1);
    }
    displayLines[maxLines - 1] = lastLine + '...';
  }

  const lineHeight = 62;
  for (const line of displayLines) {
    ctx.fillText(line, PAD, y);
    y += lineHeight;
  }

  y += 24;

  // -- Source attribution --
  ctx.font = '400 26px Nunito, system-ui, sans-serif';
  ctx.fillStyle = '#718096';
  ctx.fillText(item.source, PAD, y);

  y += 36;

  // -- Date --
  ctx.font = '400 22px Nunito, system-ui, sans-serif';
  ctx.fillStyle = '#A0AEC0';
  const dateStr = item.pubDate
    ? item.pubDate.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  ctx.fillText(dateStr, PAD, y);

  // -- Decorative accent line (separator above branding) --
  const lineY = SIZE - 180;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, lineY);
  ctx.lineTo(SIZE - PAD, lineY);
  ctx.stroke();

  // -- HappyMonitor branding --
  const brandY = SIZE - 120;
  ctx.font = '700 28px Nunito, system-ui, sans-serif';
  ctx.fillStyle = '#C4A35A'; // gold
  ctx.fillText('\u2600 HappyMonitor', PAD, brandY); // sun emoji (Unicode escape)

  ctx.font = '400 22px Nunito, system-ui, sans-serif';
  ctx.fillStyle = '#A0AEC0';
  ctx.fillText('happy.worldmonitor.app', PAD, brandY + 34);

  return canvas;
}

/**
 * Generate and share a branded PNG card for a positive news item.
 * Fallback chain: Web Share API -> clipboard -> download.
 * Follows the same pattern as StoryModal.ts lines 128-147.
 */
export async function shareHappyCard(item: NewsItem): Promise<void> {
  const canvas = await renderHappyShareCard(item);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('Canvas toBlob returned null'));
    }, 'image/png');
  });

  const file = new File([blob], 'happymonitor-story.png', { type: 'image/png' });

  // Attempt 1: Web Share API (mobile-first)
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        text: item.title,
        files: [file],
      });
      return;
    } catch {
      /* user cancelled or share failed — fall through */
    }
  }

  // Attempt 2: Copy image to clipboard
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
    return;
  } catch {
    /* clipboard write failed — fall through to download */
  }

  // Attempt 3: Download via anchor element
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'happymonitor-story.png';
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
