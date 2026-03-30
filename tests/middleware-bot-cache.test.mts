import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '..', 'middleware.ts'), 'utf-8');

describe('middleware bot responses', () => {
  it('bot UA returns 403 with Cache-Control header', () => {
    // Find the bot UA block (BOT_UA.test(ua)) followed by its Response
    const botBlock = src.match(/if\s*\(BOT_UA\.test\(ua\)\)[\s\S]*?return new Response[\s\S]*?\}\);/);
    assert.ok(botBlock, 'BOT_UA response block not found');
    assert.match(botBlock![0], /Cache-Control/, 'Bot 403 should include Cache-Control header');
    assert.match(botBlock![0], /max-age=86400/, 'Bot 403 should cache for 24h');
  });

  it('short UA returns 403 with Cache-Control header', () => {
    // Find the short UA block
    const shortBlock = src.match(/ua\.length\s*<\s*10\)\s*\{[\s\S]*?return new Response[\s\S]*?\}\);/);
    assert.ok(shortBlock, 'Short UA response block not found');
    assert.match(shortBlock![0], /Cache-Control/, 'Short UA 403 should include Cache-Control header');
    assert.match(shortBlock![0], /max-age=86400/, 'Short UA 403 should cache for 24h');
  });

  it('social preview bots are allowed on /api/story', () => {
    assert.match(src, /SOCIAL_PREVIEW_UA\.test\(ua\)/, 'Should check for social preview bots');
    assert.match(src, /SOCIAL_PREVIEW_PATHS\.has\(path\)/, 'Should allow social bots on specific paths');
  });

  it('public API paths bypass bot filtering', () => {
    assert.match(src, /PUBLIC_API_PATHS\.has\(path\)/, 'Should bypass bot filter for public paths');
  });
});
