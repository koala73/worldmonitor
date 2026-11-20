import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function rpcGatewayFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return rpcGatewayFiles(path);
    return entry.name === '[rpc].ts' ? [path] : [];
  });
}

describe('Vite dev sebuf router', () => {
  it('registers every service that a Vercel [rpc].ts gateway serves', () => {
    const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    const gateways = rpcGatewayFiles(join(root, 'api'));
    assert.ok(gateways.length > 0, 'found api/**/[rpc].ts gateways');
    const missing = gateways.flatMap((file) => {
      const factory = readFileSync(file, 'utf8').match(/\b(create\w+ServiceRoutes)\(/)?.[1];
      assert.ok(factory, `${file} builds its routes with a create*ServiceRoutes factory`);
      return viteConfig.includes(`.${factory}(`) ? [] : [`${file.slice(root.length)} (${factory})`];
    });
    assert.deepEqual(missing, [], 'vite.config.ts sebufApiPlugin must register these services');
  });
});
