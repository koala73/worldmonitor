import DOMPurify from 'dompurify';

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'strong', 'em', 'b', 'i', 'br', 'hr', 'small',
    'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan',
  ],
  ALLOWED_ATTR: [
    'class', 'style', 'title', 'aria-label',
    'viewBox', 'fill', 'stroke', 'stroke-width',
    'd', 'cx', 'cy', 'r', 'x', 'y', 'width', 'height', 'points',
    'xmlns',
  ],
  FORBID_TAGS: ['button', 'input', 'form', 'select', 'textarea', 'script', 'iframe', 'object', 'embed'],
  ALLOW_DATA_ATTR: false,
  FORCE_BODY: true,
};

const UNSAFE_STYLE_PATTERN = /url\s*\(|expression\s*\(|javascript\s*:|@import|behavior\s*:/i;

DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'style' && UNSAFE_STYLE_PATTERN.test(data.attrValue)) {
    data.keepAttr = false;
  }
});

export function sanitizeWidgetHtml(html: string): string {
  return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
}

export function wrapWidgetHtml(html: string, extraClass = ''): string {
  const shellClass = ['wm-widget-shell', extraClass].filter(Boolean).join(' ');
  return `
    <div class="${shellClass}">
      <div class="wm-widget-body">
        <div class="wm-widget-generated">${sanitizeWidgetHtml(html)}</div>
      </div>
    </div>
  `;
}

function escapeSrcdoc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

export function wrapProWidgetHtml(bodyContent: string): string {
  const doc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data:; connect-src 'none';">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
:root{--bg:#0a0a0a;--surface:#141414;--text:#e8e8e8;--text-secondary:#ccc;--text-dim:#888;--text-muted:#666;--border:#2a2a2a;--border-subtle:#1a1a1a;--overlay-subtle:rgba(255,255,255,0.03);--green:#44ff88;--red:#ff4444;--yellow:#ffaa00}
body{margin:0;padding:12px;background:var(--bg);color:var(--text);font-family:'SF Mono','Monaco','Cascadia Code','Fira Code','DejaVu Sans Mono','Liberation Mono',monospace;font-size:12px;line-height:1.5;overflow-y:auto;box-sizing:border-box}
*{box-sizing:inherit;font-family:inherit!important}
table{border-collapse:collapse;width:100%}
th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);padding:4px 8px;border-bottom:1px solid var(--border);font-weight:600}
td{padding:5px 8px;border-bottom:1px solid var(--border-subtle);color:var(--text-secondary)}
.change-positive{color:var(--green)}
.change-negative{color:var(--red)}
</style>
</head>
<body>${bodyContent}</body>
</html>`;

  return `<div class="wm-widget-shell wm-widget-pro"><iframe srcdoc="${escapeSrcdoc(doc)}" sandbox="allow-scripts" style="width:100%;height:400px;border:none;display:block;" title="Interactive widget"></iframe></div>`;
}
