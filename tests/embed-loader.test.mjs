import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loader = readFileSync(resolve(__dirname, '../public/embed.js'), 'utf-8');

describe('embed.js partner loader', () => {
  for (const [layers, expected] of [[null, null], ['', ''], ['  ', ''], ['conflicts,weather', 'conflicts,weather']]) {
    it(`forwards the layer selection ${JSON.stringify(layers)} without changing its meaning`, () => {
      const attributes = { src: 'https://www.worldmonitor.app/embed.js', 'data-layers': layers };
      let frame;
      runInNewContext(loader, {
        URL,
        window: { location: { href: 'https://partner.example/' } },
        document: {
          currentScript: {
            getAttribute: (name) => attributes[name] ?? null,
            parentNode: { insertBefore: (iframe) => { frame = iframe; } },
          },
          createElement: () => ({ style: {}, setAttribute() {} }),
        },
      });
      assert.equal(new URL(frame.src).searchParams.get('layers'), expected);
    });
  }

  it('creates an iframe without putting the API key in the URL, then posts the credential', () => {
    assert.match(loader, /document\.currentScript/);
    assert.match(loader, /iframe\.src = url/);
    assert.match(loader, /\/embed\?panel=/);
    assert.match(loader, /postMessage/);
    assert.match(loader, /source:\s*'worldmonitor-embed'/);
    assert.match(loader, /type:\s*'credential'/);
    assert.equal(/[?&]key=/.test(loader), false);
    assert.match(loader, /YOUR_WM_API_KEY/);
  });

  it('treats both documented placeholders as "no key"', () => {
    // The docs shipped YOUR_WM_API_KEY before YOUR_WME_EMBED_KEY existed, so
    // partners have unedited snippets carrying the old one. Either literal
    // reaching postMessage would be a handshake with a placeholder string.
    assert.match(loader, /key !== 'YOUR_WM_API_KEY'/);
    assert.match(loader, /key !== 'YOUR_WME_EMBED_KEY'/);
  });

  it('forwards the map view to the iframe URL so a keyed embed is not stuck on defaults', () => {
    assert.match(loader, /\['layers', 'center', 'zoom', 'variant'\]/);
    assert.match(loader, /getAttribute\('data-' \+ name\)/);
    assert.match(loader, /encodeURIComponent\(value\)/);
    // The view attributes must be appended BEFORE src is assigned, or the
    // iframe loads the default view and then never reloads.
    const viewIdx = loader.indexOf("'layers', 'center', 'zoom', 'variant'");
    const srcIdx = loader.indexOf('iframe.src = url');
    assert.ok(viewIdx !== -1 && viewIdx < srcIdx, 'view params must be built before iframe.src');
  });

  it('attaches handshake listeners before assigning iframe.src and retries the credential', () => {
    const loadIdx = loader.indexOf("iframe.addEventListener('load'");
    const readyIdx = loader.indexOf("data.type !== 'ready'");
    const srcIdx = loader.indexOf('iframe.src = url');
    const insertIdx = loader.indexOf('insertBefore(iframe');
    assert.ok(loadIdx !== -1 && loadIdx < srcIdx, 'load listener must be registered before iframe.src');
    assert.ok(readyIdx !== -1 && readyIdx < srcIdx, 'ready handshake must be registered before iframe.src');
    assert.ok(srcIdx !== -1 && srcIdx < insertIdx, 'src must be assigned before insert so both happen after listeners');
    assert.match(loader, /setInterval/);
    assert.match(loader, /attempts >= 10/);
  });
});
