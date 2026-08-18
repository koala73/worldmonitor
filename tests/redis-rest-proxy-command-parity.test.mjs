import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const proxySrc = readFileSync(resolve(here, '../docker/redis-rest-proxy.mjs'), 'utf8');
const digestSrc = readFileSync(
  resolve(here, '../server/worldmonitor/news/v1/list-feed-digest.ts'),
  'utf8',
);

describe('redis-rest-proxy command parity', () => {
  it('allows every literal Redis command emitted by the news digest', () => {
    const allowedBlock = proxySrc.match(/const ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
    const allowed = new Set([...allowedBlock.matchAll(/'([A-Z][A-Z0-9_-]*)'/g)].map((match) => match[1]));
    const emitted = new Set([...digestSrc.matchAll(/\[\s*'([A-Z][A-Z0-9_-]*)'/g)].map((match) => match[1]));
    const missing = [...emitted].filter((command) => !allowed.has(command)).sort();

    assert.deepEqual(missing, []);
  });
});
