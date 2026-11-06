'use strict';

const HTML_MATCH_RE = /<!--\s*widget-html\s*-->([\s\S]*?)<!--\s*\/widget-html\s*-->/;
const TITLE_MATCH_RE = /<!--\s*title:\s*([^\n]+?)\s*-->/;


function parseWidgetAgentResponse(text, maxHtml) {
  const source = String(text ?? '');
  const htmlMatch = source.match(HTML_MATCH_RE);
  const titleMatch = source.match(TITLE_MATCH_RE);
  const html = (htmlMatch?.[1] ?? '').slice(0, maxHtml);

  return {
    html,
    title: titleMatch?.[1]?.trim() ?? 'Custom Widget',
    hasHtmlMarkers: Boolean(htmlMatch),
    isComplete: Boolean(htmlMatch && html.trim()),
  };
}

module.exports = { parseWidgetAgentResponse };
