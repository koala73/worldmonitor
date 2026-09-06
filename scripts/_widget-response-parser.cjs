'use strict';

function parseWidgetAgentResponse(text, maxHtml) {
  const source = String(text ?? '');
  const htmlMatch = source.match(/<!--\s*widget-html\s*-->([\s\S]*?)<!--\s*\/widget-html\s*-->/);
  const titleMatch = source.match(/<!--\s*title:\s*([^\n]+?)\s*-->/);

  return {
    html: (htmlMatch?.[1] ?? source).slice(0, maxHtml),
    title: titleMatch?.[1]?.trim() ?? 'Custom Widget',
    hasHtmlMarkers: Boolean(htmlMatch),
  };
}

module.exports = { parseWidgetAgentResponse };
