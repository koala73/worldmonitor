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

    const bullet = line.match(/^\s*[*-]\s+(.+)$/);
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
  html = html.replace(/^[*-]\s+/gm, '• ');
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
  txt = txt.replace(/^[*-]\s+/gm, '• ');
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

// Headlines and LLM text are third-party content. Every Discord masked link
// starts with `[`, so escaping backslashes and opening brackets stops
// `[trusted](https://evil)` while bare URLs still render. Mirrors
// escapeDiscordText in scripts/notification-relay.cjs.
export function escapeDiscordText(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/\[/g, '\\[');
}

export function markdownToDiscord(md) {
  let txt = escapeDiscordText(md);
  txt = txt.replace(/^\*\s+/gm, '- ');
  txt = txt.replace(/^([A-Z][A-Za-z ]+): */gm, '**$1:** ');
  return txt;
}

// ── Digest story titles linked to the original report (#9214) ──────────────
// target: 'plain' | 'telegram' | 'slack' | 'discord'. Plain text has no link
// syntax, so it keeps the bare title.

export function escapeDigestText(text, target) {
  if (target === 'telegram') return escapeTelegramHtml(text);
  if (target === 'slack') return escapeSlackMrkdwn(text);
  if (target === 'discord') return escapeDiscordText(text);
  return String(text);
}

export function safeHttpUrl(link) {
  if (typeof link !== 'string' || link.length === 0) return '';
  let url;
  try { url = new URL(link); } catch { return ''; }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
}

// encodeURIComponent leaves `(` and `)` alone, so encode by code point.
function percentEncodeChar(ch) {
  return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
}

// URL.href already percent-encodes space, `"`, `<` and `>`. Each channel then
// encodes the characters that would end its own link syntax, and escapes the
// headline so a `|`, `]` or `>` in it cannot close the link early.
export function formatDigestItemTitle(rawTitle, link, target) {
  // One line per item: a line break inside a link would let a line-boundary
  // cut split it.
  const title = target === 'plain' ? rawTitle : String(rawTitle).replace(/\s+/g, ' ').trim();
  const url = target === 'plain' ? '' : safeHttpUrl(link);
  if (!url) return escapeDigestText(title, target);
  if (target === 'telegram') {
    return `<a href="${escapeTelegramHtml(url).replace(/"/g, '&quot;')}">${escapeTelegramHtml(title)}</a>`;
  }
  if (target === 'slack') {
    // Slack has no escape for `|`; U+2223 keeps the headline readable.
    return `<${url.replace(/[<>|]/g, percentEncodeChar)}|${escapeSlackMrkdwn(title).replace(/\|/g, '\u2223')}>`;
  }
  // Discord: `<url>` inside the masked link suppresses the embed preview.
  const label = String(title).replace(/[\\[\]*_~`|]/g, '\\$&');
  return `[${label}](<${url.replace(/[()<>[\]]/g, percentEncodeChar)}>)`;
}

// Cuts at Discord's 2000-char limit without splitting a `\x` escape pair.
// Prefers the last line break so a linked digest item is never cut mid-link.
export function truncateDiscordContent(text, max = 2000) {
  if (text.length <= max) return text;
  const lastNewline = text.lastIndexOf('\n', max - 2);
  if (lastNewline > max * 0.6) return text.slice(0, lastNewline + 1) + '\u2026';
  let cut = max - 1;
  let backslashes = 0;
  while (cut - 1 - backslashes >= 0 && text[cut - 1 - backslashes] === '\\') backslashes++;
  if (backslashes % 2 === 1) cut -= 1;
  return text.slice(0, openLinkStart(text, cut)) + '\u2026';
}

// Escaped text writes `[` as `\[`, so an unescaped `[` on the cut line starts
// a masked link. If that link is not closed before `cut`, rewind to it.
function openLinkStart(text, cut) {
  const lineStart = text.lastIndexOf('\n', cut - 1) + 1;
  for (let i = cut - 1; i >= lineStart; i--) {
    if (text[i] !== '[') continue;
    let backslashes = 0;
    while (i - 1 - backslashes >= lineStart && text[i - 1 - backslashes] === '\\') backslashes++;
    if (backslashes % 2 === 1) continue;
    return maskedLinkEnd(text, i) > cut ? i : cut;
  }
  return cut;
}

// End index (exclusive) of the `[label](<url>)` starting at `start`, or
// Infinity when incomplete. The label escapes `\`, `[` and `]`, and the URL
// never contains `>`, so the first unescaped `]` and the next `>` delimit it.
function maskedLinkEnd(text, start) {
  let i = start + 1;
  while (i < text.length && text[i] !== ']') i += text[i] === '\\' ? 2 : 1;
  if (text.slice(i, i + 3) !== '](<') return Infinity;
  const gt = text.indexOf('>', i + 3);
  return gt !== -1 && text[gt + 1] === ')' ? gt + 2 : Infinity;
}
