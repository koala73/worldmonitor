import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loader = readFileSync(resolve(__dirname, '../public/embed.js'), 'utf-8');

describe('embed.js partner loader', () => {
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
