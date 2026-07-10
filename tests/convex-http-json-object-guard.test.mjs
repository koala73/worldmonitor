import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, '..', 'convex', 'http.ts'), 'utf8');

const guardedPaths = [
  '/api/internal-entitlements',
  '/api/user-prefs',
  '/api/telegram-pair-callback',
  '/relay/deactivate',
  '/relay/channels',
  '/relay/notification-channels',
  '/relay/user-preferences',
  '/relay/followed-countries',
  '/relay/entitlement',
  '/relay/register-referral-code',
  '/api/internal-validate-api-key',
  '/api/internal-get-key-owner',
  '/api/internal-issue-pro-mcp-token',
  '/api/internal-validate-pro-mcp-token',
  '/api/internal-revoke-pro-mcp-token',
  '/relay/create-checkout',
  '/relay/customer-portal',
  '/relay/bulk-suppress-emails',
];

describe('convex/http JSON object body guard', () => {
  it('uses the shared parser for every authenticated JSON POST route', () => {
    assert.match(source, /async function parseJsonObjectBody/);
    assert.equal(
      (source.match(/await request\.json\(\)/g) ?? []).length,
      1,
      'only the shared parser may parse JSON directly',
    );

    for (const path of guardedPaths) {
      const routeStart = source.indexOf(`path: "${path}",\n  method: "POST"`);
      assert.notEqual(routeStart, -1, `missing ${path} route`);
      const nextRoute = source.indexOf('http.route({', routeStart + 1);
      const route = source.slice(routeStart, nextRoute === -1 ? undefined : nextRoute);
      assert.match(route, /parseJsonObjectBody[\s\S]*?\(request\)/, `${path} bypasses object guard`);
    }
  });
});
