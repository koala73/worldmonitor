/**
 * Pure post-processing for analyst markdown HTML output.
 * Takes the HTML string produced by marked.parse() and promotes ALL-CAPS-only
 * paragraphs to section-header divs, preserving the analyst prompt's SIGNAL /
 * THESIS / RISK / WATCH visual treatment.
 *
 * No DOM dependency — safe to import in Node.js test runners.
 */

// **SIGNAL** → <div class="chat-section-header">SIGNAL</div>
const BOLD_CAPS_RE = /<p><strong>([A-Z][A-Z\s/]{1,29})<\/strong><\/p>/g;
// Plain SIGNAL (4–25 chars, all caps/spaces) → section header
const PLAIN_CAPS_RE = /<p>([A-Z][A-Z\s]{3,24})<\/p>/g;

export function postProcessAnalystHtml(html: string): string {
  return html
    .replace(BOLD_CAPS_RE, '<div class="chat-section-header">$1</div>')
    .replace(PLAIN_CAPS_RE, '<div class="chat-section-header">$1</div>');
}

const FENCE_RE = /^ {0,3}```/gm;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const BULLET_STAR_RE = /^( {0,3})\*(?=\s)/gm;
const TRAILING_STARS_RE = /\*+$/;

/**
 * Blank out (same length) everything that is not an emphasis marker, so marker
 * positions in the result index straight into the original text: inline code
 * spans and `* ` list bullets.
 */
function maskNonEmphasis(text: string): string {
  return text
    .replace(INLINE_CODE_RE, (span) => ' '.repeat(span.length))
    .replace(BULLET_STAR_RE, '$1 ');
}

/** Index of the last unmatched `**` and `*` opener, or -1 when balanced. */
function openEmphasis(text: string): { bold: number; italic: number } {
  const masked = maskNonEmphasis(text);
  const bolds = [...masked.matchAll(/\*\*/g)].map((m) => m.index);
  // Lone `*` markers once every `**` pair is blanked out.
  const singles = [...masked.replace(/\*\*/g, '  ').matchAll(/\*/g)].map((m) => m.index);
  return {
    bold: bolds.length % 2 === 1 ? bolds[bolds.length - 1]! : -1,
    italic: singles.length % 2 === 1 ? singles[singles.length - 1]! : -1,
  };
}

/**
 * Make a partial (still streaming) analyst answer safe to run through marked,
 * so the streaming bubble shows formatted text instead of raw markers.
 *
 * - An open code fence is closed, so the partial code renders as a block.
 * - A trailing run of asterisks that does not close an open `**` or `*` run
 *   (the first half of a `**` split across chunks, or an opener with no text
 *   yet) is dropped.
 * - A `**` or `*` run still open at the end is closed, innermost first. If it
 *   spans a line break, marked could not pair it anyway, so its opener is
 *   dropped instead.
 *
 * Only the display copy is balanced; the accumulated answer is left untouched.
 */
export function balanceStreamingMarkdown(text: string): string {
  if ((text.match(FENCE_RE) ?? []).length % 2 === 1) return `${text}\n\`\`\``;

  let out = text.trimEnd();
  const trailing = TRAILING_STARS_RE.exec(out);
  if (trailing) {
    const before = out.slice(0, trailing.index);
    const open = openEmphasis(before);
    const run = trailing[0].length;
    const closes = (run === 1 && open.italic >= 0)
      || (run === 2 && open.bold >= 0)
      || (run >= 3 && (open.bold >= 0 || open.italic >= 0));
    if (!closes) out = before.trimEnd();
  }

  const open = openEmphasis(out);
  // Close the innermost (latest) opener first so nesting stays valid.
  const openers = [
    { index: open.bold, marker: '**' },
    { index: open.italic, marker: '*' },
  ].filter((o) => o.index >= 0).sort((x, y) => y.index - x.index);
  let closers = '';
  for (const { index, marker } of openers) {
    const rest = out.slice(index + marker.length);
    if (rest.includes('\n') || rest.trim() === '') {
      out = out.slice(0, index) + rest;
    } else {
      closers += marker;
    }
  }
  return out + closers;
}
