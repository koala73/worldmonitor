// MCP Implementation metadata (title, description, websiteUrl, icons) on the
// handshake and its mirror in the static server card.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { SERVER_INFO, SERVER_NAME, SERVER_VERSION } from '../api/mcp/constants.ts';

const card = JSON.parse(readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'));

describe('MCP serverInfo metadata', () => {
  it('keeps name and version and adds a human title, description and website', () => {
    assert.equal(SERVER_INFO.name, SERVER_NAME);
    assert.equal(SERVER_INFO.version, SERVER_VERSION);
    assert.equal(SERVER_INFO.title, 'WorldMonitor');
    assert.ok(SERVER_INFO.description.length >= 60 && SERVER_INFO.description.length <= 400);
    assert.equal(SERVER_INFO.websiteUrl, 'https://www.worldmonitor.app');
  });

  it('advertises icons of 128px or more on the MCP endpoint origin (apex /.well-known/, not redirected to www)', () => {
    assert.ok(SERVER_INFO.icons.length > 0);
    for (const icon of SERVER_INFO.icons) {
      assert.match(icon.src, /^https:\/\/worldmonitor\.app\/\.well-known\/mcp\/[\w.-]+$/);
      assert.ok(existsSync(new URL(`../public${new URL(icon.src).pathname}`, import.meta.url)), icon.src);
      assert.ok(icon.mimeType.startsWith('image/'));
      const px = Number(icon.sizes[0].split('x')[0]);
      assert.ok(px >= 128, `${icon.src} ${icon.sizes}`);
    }
  });

  it('server card serverInfo mirrors the handshake identity fields', () => {
    for (const k of ['name', 'version', 'title', 'websiteUrl']) assert.equal(card.serverInfo[k], SERVER_INFO[k], k);
    assert.deepEqual(card.serverInfo.icons, SERVER_INFO.icons);
  });
});
