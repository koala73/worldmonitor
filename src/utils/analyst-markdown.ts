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
