type PluginDocument = {
  origin: string;
  entry: 'country.html' | 'plugin.html' | 'market.html';
  root: 'countryRoot' | 'pluginRoot' | 'marketRoot';
};

export function buildPluginShell(config: PluginDocument): string {
  const args = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><base href="${config.origin}/"><title>WorldMonitor</title><style>body:has(#pluginBoot){margin:0;background:#141414;color:#eee;font:16px system-ui}#pluginBoot{padding:24px}#pluginBoot button{font:inherit;padding:8px 16px;background:#222;color:inherit;border:1px solid #555;border-radius:4px}</style></head><body><div id="pluginBoot"><p role="status">Loading WorldMonitor…</p></div><script>(${BOOT_SCRIPT})(${args});</script></body></html>`;
}

const BOOT_SCRIPT = String.raw`async function(config) {
  const styles = [];
  const assetUrl = (path, extension) => {
    const url = new URL(path, config.origin);
    if (url.origin !== config.origin || url.search || url.hash || !new RegExp('^/plugin/assets/[a-zA-Z0-9_.-]+\\.' + extension + '$').test(url.pathname)) {
      throw new Error('Unexpected panel asset');
    }
    return url.href;
  };
  const showFailure = () => {
    styles.splice(0).forEach(link => link.remove());
    const notice = document.createElement('div');
    notice.id = 'pluginBoot';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'WorldMonitor could not load its interface. Retry to load the current version.';
    const retry = document.createElement('button');
    retry.textContent = 'Retry interface';
    retry.onclick = () => { location.reload(); };
    notice.append(status, retry);
    document.body.replaceChildren(notice);
  };
  const load = async () => {
    document.body.className = '';
    const loading = document.createElement('div');
    loading.id = 'pluginBoot';
    loading.setAttribute('role', 'status');
    loading.textContent = 'Loading WorldMonitor…';
    document.body.replaceChildren(loading);
    try {
      const response = await fetch(config.origin + '/plugin/' + config.entry, {
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html') || !response.body) throw new Error('Missing panel document');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let html = '';
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 131072) throw new Error('Panel document too large');
          html += decoder.decode(chunk.value, { stream: true });
        }
        html += decoder.decode();
      } finally { await reader.cancel(); }
      const current = new DOMParser().parseFromString(html, 'text/html');
      const modules = current.querySelectorAll('script[type="module"][src]');
      if (!current.getElementById(config.root) || modules.length !== 1) throw new Error('Invalid panel document');
      const entry = assetUrl(modules[0].getAttribute('src'), 'js');
      const css = [...current.querySelectorAll('link[rel="stylesheet"]')].map(link => assetUrl(link.getAttribute('href'), 'css'));
      current.querySelectorAll('script, link, base').forEach(node => node.remove());
      await Promise.all(css.map(href => new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.crossOrigin = 'anonymous';
        const timeout = setTimeout(() => { link.remove(); reject(new Error('Panel style timed out')); }, 10000);
        link.onload = () => { clearTimeout(timeout); resolve(); };
        link.onerror = () => { clearTimeout(timeout); reject(new Error('Panel style unavailable')); };
        styles.push(link);
        document.head.append(link);
      })));
      document.body.className = current.body.className;
      document.body.replaceChildren(...current.body.childNodes);
      document.documentElement.dataset.wmPluginManagedBoot = 'true';
      let timeout;
      try {
        await Promise.race([
          import(entry),
          new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('Panel module timed out')), 10000); }),
        ]);
      } finally { clearTimeout(timeout); }
      document.dispatchEvent(new Event('wm-plugin-mount'));
    } catch { showFailure(); }
  };
  await load();
}`;
