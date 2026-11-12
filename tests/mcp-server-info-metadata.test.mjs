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

  // Cloudflare Hotlink Protection answers a PNG request that carries a foreign
  // Referer with 403 (error 1011), so a client page on another origin (Manufact's
  // inspector, a web host's connector list) could not show the icon. Files under
  // a `hotlink-ok` directory are exempt from the check without turning it off for
  // the rest of the zone.
  it('advertises icons of 128px or more on the MCP endpoint origin (apex /.well-known/, not redirected to www), under hotlink-ok', () => {
    assert.ok(SERVER_INFO.icons.length > 0);
    for (const icon of SERVER_INFO.icons) {
      assert.match(icon.src, /^https:\/\/worldmonitor\.app\/\.well-known\/mcp\/hotlink-ok\/[\w.-]+$/);
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

  // The cards' own icon fields are fetched by the same cross-origin pages, so
  // they need the exempt path too, and the file has to exist.
  it('every card icon field points at a hotlink-ok file that exists', () => {
    const files = {
      'public/.well-known/mcp/server-card.json': 'icon',
      'public/.well-known/mcp/docs-server-card.json': 'icon',
      'public/.well-known/agent-card.json': 'iconUrl',
    };
    for (const [file, key] of Object.entries(files)) {
      const json = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
      assert.match(json[key], /^https:\/\/worldmonitor\.app\/\.well-known\/mcp\/hotlink-ok\/[\w.-]+$/, `${file} ${key}`);
      assert.ok(existsSync(new URL(`../public${new URL(json[key]).pathname}`, import.meta.url)), `${file} ${key} file`);
    }
  });
});
