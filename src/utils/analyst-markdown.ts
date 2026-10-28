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
const TRAILING_STARS_RE = /\*+$/;

/** Blank out inline code spans (same length) so their asterisks are not counted. */
function maskInlineCode(text: string): string {
  return text.replace(INLINE_CODE_RE, (span) => ' '.repeat(span.length));
}

function countBold(text: string): number {
  return (maskInlineCode(text).match(/\*\*/g) ?? []).length;
}

/**
 * Make a partial (still streaming) analyst answer safe to run through marked,
 * so the streaming bubble shows formatted text instead of raw markers.
 *
 * - An open code fence is closed, so the partial code renders as a block.
 * - A trailing run of asterisks that does not close an open bold run (the first
 *   half of a `**` split across chunks, or an opener with no text yet) is dropped.
 * - A bold run still open at the end is closed. If it spans a line break, marked
 *   could not pair it anyway, so its opener is dropped instead.
 *
 * Only the display copy is balanced; the accumulated answer is left untouched.
 */
export function balanceStreamingMarkdown(text: string): string {
  if ((text.match(FENCE_RE) ?? []).length % 2 === 1) return `${text}\n\`\`\``;

  let out = text.trimEnd();
  const trailing = TRAILING_STARS_RE.exec(out);
  if (trailing) {
    const before = out.slice(0, trailing.index);
    const closesOpenBold = countBold(before) % 2 === 1 && trailing[0].length >= 2;
    if (!closesOpenBold) out = before.trimEnd();
  }

  if (countBold(out) % 2 === 1) {
    const opener = maskInlineCode(out).lastIndexOf('**');
    const rest = out.slice(opener + 2);
    out = rest.includes('\n') || rest.trim() === ''
      ? out.slice(0, opener) + rest
      : `${out}**`;
  }
  return out;
}
