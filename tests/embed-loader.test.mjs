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
});
