/**
 * Pure markdown → channel-specific format converters for the digest
 * notification script. Extracted so tests can import without triggering
 * the seed script's top-level execution (Upstash init, main()).
 *
 * Converters cover the AI executive summary markdown that Claude emits:
 *   **bold** / __bold__
 *   *italic*
 *   * / - bullet lists
 *   "Assessment:" / "Signals to watch:" section headers
 */

// ── HTML escape (email: " encoded too for attribute safety) ──────────────────

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Email HTML ──────────────────────────────────────────────────────────────

// Inline markdown → HTML (operates on already-HTML-escaped text, no block markup).
export function renderEmailInline(text) {
  let out = text;
  // Bold: **text** or __text__
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#fff;">$1</strong>');
  out = out.replace(/__(.+?)__/g, '<strong style="color:#fff;">$1</strong>');
  // Italic: *text* (not adjacent to another asterisk, avoids collision w/ bold)
  out = out.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
  // Section header (label at start of the block, e.g. "Assessment:", "Signals to watch:")
  out = out.replace(
    /^([A-Z][A-Za-z ]+): */,
    '<strong style="color:#4ade80;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">$1:</strong> ',
  );
  return out;
}

// Block-level markdown → HTML. Splits the summary into paragraph and list
// blocks first, then applies inline formatting within each block, so we
// never nest <ul> inside <p> or split a list across paragraphs.
export function markdownToEmailHtml(md) {
  const escaped = escapeHtml(md);
  const lines = escaped.split('\n');

  /** @type {Array<{type:'p'|'ul', items:string[]}>} */
  const blocks = [];
  let current = null;
  const flush = () => { if (current) { blocks.push(current); current = null; } };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }

    const bullet = line.match(/^\s*[\*\-]\s+(.+)$/);
    if (bullet) {
      if (!current || current.type !== 'ul') { flush(); current = { type: 'ul', items: [] }; }
      current.items.push(bullet[1]);
    } else {
      if (!current || current.type !== 'p') { flush(); current = { type: 'p', items: [] }; }
      current.items.push(trimmed);
    }
  }
  flush();

  return blocks.map((block) => {
    if (block.type === 'ul') {
      const items = block.items
        .map((item) => `<li style="margin-bottom:6px;">${renderEmailInline(item)}</li>`)
        .join('');
      return `<ul style="margin:12px 0;padding-left:20px;list-style:disc;">${items}</ul>`;
    }
    const joined = block.items.map(renderEmailInline).join('<br/>');
    return `<p style="margin:0 0 12px;">${joined}</p>`;
  }).join('');
}

// ── Telegram HTML (parse_mode:'HTML') ────────────────────────────────────────
// Telegram HTML escape: only &, <, > (no " or ')
// See https://core.telegram.org/bots/api#html-style

export function escapeTelegramHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function markdownToTelegramHtml(md) {
  let html = escapeTelegramHtml(md);
  // Bullets first (Telegram HTML has no list elements, render as • char)
  html = html.replace(/^[\*\-]\s+/gm, '• ');
  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/__(.+?)__/g, '<b>$1</b>');
  // Italic: *text* (single asterisk, not part of bold)
  html = html.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<i>$1</i>');
  // Section headers: Assessment: / Signals to watch:
  html = html.replace(/^([A-Z][A-Za-z ]+): */gm, '<b>$1:</b> ');
  return html;
}

// ── Slack mrkdwn ─────────────────────────────────────────────────────────────
// Slack escapes &, <, > (Slack auto-parses these in regular text).

export function escapeSlackMrkdwn(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function markdownToSlackMrkdwn(md) {
  let txt = escapeSlackMrkdwn(md);
  // Bullets first (avoid collision with italic single-asterisk regex)
  txt = txt.replace(/^[\*\-]\s+/gm, '• ');
  // Bold: **text** or __text__ → *text* (Slack uses single asterisk).
  // Use \u0001 placeholder so italic pass below doesn't re-match.
  txt = txt.replace(/\*\*(.+?)\*\*/g, '\u0001$1\u0001');
  txt = txt.replace(/__(.+?)__/g, '\u0001$1\u0001');
  // Italic: *text* → _text_
  txt = txt.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '_$1_');
  // Restore bold markers
  txt = txt.replace(/\u0001/g, '*');
  // Section headers → *bold*
  txt = txt.replace(/^([A-Z][A-Za-z ]+): */gm, '*$1:* ');
  return txt;
}

// ── Discord CommonMark (natively supports **bold**, *italic*) ────────────────
// Only normalize what Discord doesn't handle: * bullets (Discord lists require -)
// and trailing-colon section headers.

export function markdownToDiscord(md) {
  let txt = String(md);
  txt = txt.replace(/^\*\s+/gm, '- ');
  txt = txt.replace(/^([A-Z][A-Za-z ]+): */gm, '**$1:** ');
  return txt;
}
