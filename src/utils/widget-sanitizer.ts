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

const widgetBodyStore = new Map<string, string>();

function buildWidgetDoc(bodyContent: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data:; connect-src https://cdn.jsdelivr.net;">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
:root{--bg:#0a0a0a;--surface:#141414;--text:#e8e8e8;--text-secondary:#ccc;--text-dim:#888;--text-muted:#666;--border:#2a2a2a;--border-subtle:#1a1a1a;--overlay-subtle:rgba(255,255,255,0.03);--green:#44ff88;--red:#ff4444;--yellow:#ffaa00;--accent:#44ff88}
body{margin:0;padding:12px;background:var(--bg);color:var(--text);font-family:'SF Mono','Monaco','Cascadia Code','Fira Code','DejaVu Sans Mono','Liberation Mono',monospace;font-size:12px;line-height:1.5;overflow-y:auto;box-sizing:border-box}
*{box-sizing:inherit;font-family:inherit!important}
table{border-collapse:collapse;width:100%}
th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);padding:4px 8px;border-bottom:1px solid var(--border);font-weight:600}
td{padding:5px 8px;border-bottom:1px solid var(--border-subtle);color:var(--text-secondary)}
.change-positive{color:var(--green)}
.change-negative{color:var(--red)}
.panel-header{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:var(--overlay-subtle);border-bottom:1px solid var(--border);margin:-12px -12px 0}
.panel-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text)}
.panel-tabs{display:flex;gap:2px;padding:6px 10px 0;border-bottom:1px solid var(--border);margin:0 -12px}
.panel-tab{font-size:11px;font-weight:500;color:var(--text-muted);padding:4px 10px;border:none;border-bottom:2px solid transparent;cursor:pointer;background:none;letter-spacing:0.5px;text-transform:uppercase}
.panel-tab:hover{color:var(--text);background:var(--overlay-subtle)}
.panel-tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.disp-stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;background:var(--border);margin-top:8px}
.disp-stat-box{background:var(--bg);padding:8px}
.disp-stat-value{display:block;font-size:16px;font-variant-numeric:tabular-nums;color:var(--text);font-weight:500}
.disp-stat-label{display:block;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-top:2px}
</style>
</head>
<body>${bodyContent}</body>
</html>`;
}

function mountProWidget(iframe: HTMLIFrameElement): void {
  const id = iframe.dataset.wmId;
  if (!id) return;
  const body = widgetBodyStore.get(id);
  if (!body) return;
  // Delete immediately — new ID is generated on every render, so no re-use
  widgetBodyStore.delete(id);
  const html = buildWidgetDoc(body);
  // Always use load event: when MutationObserver fires, iframe.contentDocument is
  // still about:blank (readyState 'complete'), not the sandbox page. Sending here
  // would target the wrong window. Wait for the real load instead.
  iframe.addEventListener('load', () => {
    iframe.contentWindow?.postMessage({ type: 'wm-html', html }, '*');
  }, { once: true });
}

if (typeof document !== 'undefined') {
  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLIFrameElement && node.dataset.wmId) {
          mountProWidget(node);
        } else {
          node.querySelectorAll<HTMLIFrameElement>('iframe[data-wm-id]').forEach(mountProWidget);
        }
      }
    }
  });
  const startObserving = (): void => {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
  } else {
    startObserving();
  }
}

export function wrapProWidgetHtml(bodyContent: string): string {
  const id = `wm-${Math.random().toString(36).slice(2)}`;
  widgetBodyStore.set(id, bodyContent);
  return `<div class="wm-widget-shell wm-widget-pro"><iframe src="/wm-widget-sandbox.html" data-wm-id="${id}" sandbox="allow-scripts" style="width:100%;height:400px;border:none;display:block;" title="Interactive widget"></iframe></div>`;
}
