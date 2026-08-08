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

// Strip a leading .panel-header that the agent may generate — the outer
// CustomWidgetPanel frame already displays the title, so a second one is
// always a duplicate. Only the very first element is removed.
function stripLeadingPanelHeader(html: string): string {
  return html.replace(/^\s*<div[^>]*\bclass="panel-header"[^>]*>[\s\S]*?<\/div>\s*/i, '');
}

export function wrapWidgetHtml(html: string, extraClass = ''): string {
  const shellClass = ['wm-widget-shell', extraClass].filter(Boolean).join(' ');
  return `
    <div class="${shellClass}">
      <div class="wm-widget-body">
        <div class="wm-widget-generated">${sanitizeWidgetHtml(stripLeadingPanelHeader(html))}</div>
      </div>
    </div>
  `;
}

const widgetBodyStore = new Map<string, string>();

// Keyed by iframe element so the parent can answer sandbox readiness messages
// after initial mount or iframe re-navigation.
const iframeHtmlStore = new WeakMap<HTMLIFrameElement, string>();
const iframeTokenStore = new WeakMap<HTMLIFrameElement, { id: string; token: string }>();
// AbortController per mounted iframe — scopes the global `message` listener
// to the iframe's DOM lifetime so it can be torn down on iframe removal.
// Without this, every mounted PRO widget leaks a window-level listener that
// retains a strong reference to the iframe element (and its ~80 KB HTML
// payload via iframeHtmlStore), preventing garbage collection in long-
// running dashboard sessions that add/remove widgets repeatedly.
const iframeAbortStore = new WeakMap<HTMLIFrameElement, AbortController>();
// Throttle re-deliveries of the same HTML to one per second per iframe.
// A real iframe re-navigation (drag/drop reload) is human-paced and easily
// clears this floor; a malicious widget script that re-posts wm-widget-
// ready in a tight loop after receiving its document is rate-gated and
// cannot trigger an unbounded document.write storm.
const iframeLastDeliveryMs = new WeakMap<HTMLIFrameElement, number>();
const MIN_DELIVERY_INTERVAL_MS = 1000;

function createWidgetToken(): string {
  const crypto = globalThis.crypto;
  if (!crypto) {
    throw new Error('crypto API unavailable for widget sandbox token');
  }
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function buildWidgetDoc(bodyContent: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data:; connect-src https://cdn.jsdelivr.net;">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
:root{--bg:#0a0a0a;--surface:#141414;--text:#e8e8e8;--text-secondary:#ccc;--text-dim:#888;--text-muted:#666;--border:#2a2a2a;--border-subtle:#1a1a1a;--overlay-subtle:rgba(255,255,255,0.03);--green:#44ff88;--red:#ff4444;--yellow:#ffaa00;--accent:#44ff88}
html,body{font-family:'SF Mono','Monaco','Cascadia Code','Fira Code','DejaVu Sans Mono','Liberation Mono',monospace!important}
body{margin:0;padding:12px;background:var(--bg);color:var(--text);font-size:12px;line-height:1.5;overflow-y:auto;box-sizing:border-box}
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

  // Already wired up — the sandbox will request HTML again after re-navigation.
  if (iframeHtmlStore.has(iframe)) return;

  const body = widgetBodyStore.get(id);
  if (!body) return;
  widgetBodyStore.delete(id);
  const html = buildWidgetDoc(body);
  const token = iframe.dataset.wmToken;
  if (!token) return;
  iframeHtmlStore.set(iframe, html);
  iframeTokenStore.set(iframe, { id, token });

  const controller = new AbortController();
  iframeAbortStore.set(iframe, controller);

  window.addEventListener('message', (event) => {
    const mounted = iframeTokenStore.get(iframe);
    if (!mounted) return;
    if (event.source !== iframe.contentWindow) return;
    if (!event.data || event.data.type !== 'wm-widget-ready') return;
    if (event.data.id !== mounted.id || event.data.token !== mounted.token) return;
    const storedHtml = iframeHtmlStore.get(iframe);
    if (!storedHtml) return;
    const now = performance.now();
    const last = iframeLastDeliveryMs.get(iframe) ?? 0;
    if (now - last < MIN_DELIVERY_INTERVAL_MS) return;
    iframeLastDeliveryMs.set(iframe, now);
    // The iframe deliberately uses sandbox="allow-scripts" without
    // allow-same-origin, so its origin is opaque. A concrete targetOrigin
    // cannot match that sandbox origin; '*' is the strictest deliverable
    // target here. The sandbox still gates the HTML write on source,
    // per-widget id/token, and an allowlisted parent origin from referrer.
    iframe.contentWindow?.postMessage(
      { type: 'wm-html', id: mounted.id, token: mounted.token, html: storedHtml },
      '*',
    );
  }, { signal: controller.signal });
}

function unmountProWidget(iframe: HTMLIFrameElement): void {
  iframeAbortStore.get(iframe)?.abort();
  iframeAbortStore.delete(iframe);
  iframeTokenStore.delete(iframe);
  iframeHtmlStore.delete(iframe);
  iframeLastDeliveryMs.delete(iframe);
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
      for (const node of mut.removedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLIFrameElement && node.dataset.wmId) {
          unmountProWidget(node);
        } else {
          node.querySelectorAll<HTMLIFrameElement>('iframe[data-wm-id]').forEach(unmountProWidget);
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
  const token = createWidgetToken();
  widgetBodyStore.set(id, stripLeadingPanelHeader(bodyContent));
  const src = `/wm-widget-sandbox.html#id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
  return `<div class="wm-widget-shell wm-widget-pro"><iframe src="${src}" data-wm-id="${id}" data-wm-token="${token}" sandbox="allow-scripts" style="width:100%;height:400px;border:none;display:block;" title="Interactive widget"></iframe></div>`;
}
