/**
 * HTML for the in-app travel risk assessment export (#10451, phase 2).
 *
 * The draft is assembled once, as Markdown, by `renderTravelRiskMarkdown`
 * (api/mcp/registry/_travel-risk-document.ts). This converts that Markdown, so
 * the Markdown file and the Word/PDF file cannot disagree about what the draft
 * says. It is not a general Markdown renderer. It reads the closed grammar the
 * assembler writes: `#`/`##`/`###` headings, paragraphs, `-` and `1.` lists,
 * pipe tables, `**bold**`, `<https://…>` links and backslash escapes.
 *
 * Feed text reaches the Markdown already neutralised by `cleanText`: no live
 * link, emphasis, code span or HTML, with `\ [ ] < > \` * _ ~` escaped. This
 * reader therefore (1) turns every backslash escape back into the literal
 * character and HTML-escapes it, (2) escapes every character it does not own,
 * and (3) emits an anchor only for an `https://` address. An angle bracket
 * that is not part of an `https` autolink is text, so no feed string can start
 * a tag whatever the Markdown layer missed.
 *
 * The output uses plain CSS 2 only (no variables, flex, grid or external
 * resources) so Word and Google Docs open it, and a print stylesheet that
 * wraps wide cells instead of clipping them.
 */

const ESCAPABLE = /[\\[\]<>`*_~|]/;
const AUTOLINK = /^<(https:\/\/[^\s<>"]+)>/;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  ));
}

/** Escaped text with the assembler's inline syntax applied. */
function inline(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length && ESCAPABLE.test(text[i + 1]!)) {
      out += escapeHtml(text[i + 1]!);
      i += 2;
      continue;
    }
    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) {
        out += `<strong>${inline(text.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if (ch === '<') {
      const link = AUTOLINK.exec(text.slice(i));
      if (link) {
        out += `<a href="${escapeHtml(link[1]!)}">${escapeHtml(link[1]!)}</a>`;
        i += link[0].length;
        continue;
      }
    }
    out += escapeHtml(ch);
    i += 1;
  }
  return out;
}

/** Plain text of an inline run: escapes undone, no markup. */
function plain(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\\([\\[\]<>`*_~|])/g, '$1');
}

function tableCells(line: string): string[] {
  return line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
}

const STYLE = `
  body { font-family: Calibri, Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.45; color: #111111; margin: 24pt auto; max-width: 760px; padding: 0 12pt; }
  h1 { font-size: 20pt; margin: 0 0 10pt 0; }
  h2 { font-size: 15pt; margin: 22pt 0 6pt 0; border-bottom: 1px solid #999999; padding-bottom: 3pt; }
  h3 { font-size: 12pt; margin: 14pt 0 4pt 0; }
  p { margin: 0 0 8pt 0; }
  ul, ol { margin: 0 0 8pt 0; padding-left: 22pt; }
  li { margin: 0 0 3pt 0; }
  a { color: #0b4f9c; word-wrap: break-word; overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 6pt 0 10pt 0; }
  th, td { border: 1px solid #999999; padding: 4pt 6pt; text-align: left; vertical-align: top; word-wrap: break-word; overflow-wrap: anywhere; font-size: 10pt; }
  th { background-color: #eeeeee; }
  @media print {
    body { margin: 0; max-width: none; padding: 0; font-size: 10.5pt; }
    h1, h2, h3 { page-break-after: avoid; }
    table { page-break-inside: auto; }
    tr { page-break-inside: avoid; }
    thead { display: table-header-group; }
    a { color: #111111; text-decoration: underline; }
  }
`;

/** A full HTML document for the Markdown draft. */
export function renderTravelRiskHtml(markdown: string): string {
  const lines = markdown.split('\n');
  const body: string[] = [];
  let title = 'Travel risk assessment draft';
  let paragraph: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let table: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) body.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) body.push(`<${list.tag}>\n${list.items.map((item) => `<li>${inline(item)}</li>`).join('\n')}\n</${list.tag}>`);
    list = null;
  };
  const flushTable = () => {
    if (table.length) {
      const [head, , ...rows] = table;
      const header = tableCells(head!).map((cell) => `<th>${inline(cell)}</th>`).join('');
      const bodyRows = rows.map((row) => `<tr>${tableCells(row).map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`);
      body.push(`<table>\n<thead>\n<tr>${header}</tr>\n</thead>\n<tbody>\n${bodyRows.join('\n')}\n</tbody>\n</table>`);
    }
    table = [];
  };
  const flush = () => { flushParagraph(); flushList(); flushTable(); };

  for (const line of lines) {
    if (line.trim() === '') { flush(); continue; }
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      if (level === 1) title = plain(heading[2]!);
      body.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }
    if (line.startsWith('|')) {
      flushParagraph(); flushList();
      table.push(line);
      continue;
    }
    const ordered = /^\d+\. (.*)$/.exec(line);
    const bullet = /^- (.*)$/.exec(line);
    if (ordered || bullet) {
      flushParagraph(); flushTable();
      const tag = ordered ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      // The list element numbers an ordered item, so the Markdown's own number
      // is dropped rather than printed twice.
      list.items.push((ordered ?? bullet)![1]!);
      continue;
    }
    flushList(); flushTable();
    paragraph.push(line);
  }
  flush();

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    body.join('\n'),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
