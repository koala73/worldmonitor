import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import analyticsHealthHandler from '../api/analytics-health.js';
import correlationRuntimeModeHandler from '../api/correlation-runtime-mode.js';
import securityReportHandler from '../api/security/report.js';
import middleware from '../middleware.ts';
import { checkProMcpAccess } from '../server/_shared/pro-mcp-gate.ts';
import { ENDPOINT_RATE_POLICIES } from '../server/_shared/rate-limit.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const agentDiscovery = read('docs/agent-discovery.mdx');
const apiPlatform = read('docs/api-platform.mdx');
const mcpOverview = read('docs/mcp-overview.mdx');
const apiOauth = read('docs/api-oauth.mdx');
const mcpErrors = read('docs/mcp-error-catalog.mdx');
const usageErrors = read('docs/usage-errors.mdx');

describe('API documentation stays aligned with runtime policy boundaries', () => {
  it('names the rate-limited agent front doors without assigning a limiter to every surface', () => {
    for (const path of ['/api/ask', '/api/a2a', '/api/docs-mcp']) {
      assert.deepEqual(ENDPOINT_RATE_POLICIES[path], { limit: 60, window: '60 s' });
    }
    for (const path of ['/api/agent-auth', '/api/md-twin']) {
      assert.equal(ENDPOINT_RATE_POLICIES[path], undefined);
    }

    assert.match(agentDiscovery, /`\/ask`[^\n]*`\/a2a`[^\n]*`\/docs\/mcp`[^\n]*60\/min\/IP/i);
    assert.match(agentDiscovery, /`\/agent\/auth`[^\n]*markdown twins[^\n]*do not claim[^\n]*per-IP/i);
    assert.doesNotMatch(agentDiscovery, /each has its own per-IP rate limit/i);
  });

  it('separates the wildcard-CORS reporting sink from origin-gated operational routes', async () => {
    const reportPreflight = await securityReportHandler(new Request('https://worldmonitor.app/api/security/report', {
      method: 'OPTIONS',
      headers: { Origin: 'https://untrusted.example' },
    }));
    assert.equal(reportPreflight.status, 204);
    assert.equal(reportPreflight.headers.get('Access-Control-Allow-Origin'), '*');

    const hostileRequest = () => new Request('https://worldmonitor.app/api/internal', {
      headers: { Origin: 'https://untrusted.example' },
    });
    for (const handler of [analyticsHealthHandler, correlationRuntimeModeHandler]) {
      const response = await handler(hostileRequest());
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    }

    assert.match(apiPlatform, /`POST \/api\/security\/report`[\s\S]*?wildcard CORS/i);
    assert.match(apiPlatform, /analytics-health[\s\S]*?correlation-runtime-mode[\s\S]*?origin-gated/i);
    assert.doesNotMatch(apiPlatform, /Internal ops surfaces[^\n]*origin-gated/i);
  });

  it('documents a provider-confirmed lapse as the restricted free-account OAuth path', () => {
    const gate = checkProMcpAccess({
      planKey: 'pro',
      features: { tier: 0, mcpAccess: false },
      validUntil: 0,
      billingStatus: 'subscription_lapsed',
    }, Date.now());
    assert.deepEqual(gate, { kind: 'free_account' });

    for (const doc of [mcpOverview, apiOauth, mcpErrors, usageErrors]) {
      assert.match(doc, /provider-confirmed[^\n]*(?:lapse|ended coverage)[^\n]*free-account/i);
    }
    assert.doesNotMatch(mcpOverview, /lapsed[^\n]*refused at the OAuth step/i);
    assert.doesNotMatch(apiOauth, /refuses lapsed paid entitlements/i);
    assert.doesNotMatch(mcpErrors, /provider-confirmed lapses use the more specific `lapsed-subscription` reason/i);
    assert.doesNotMatch(usageErrors, /Pro-MCP OAuth flow[^\n]*subscription_lapsed[^\n]*verdict/i);
    assert.doesNotMatch(usageErrors, /INSUFFICIENT_TIER[^.\n]*including[^.\n]*provider-confirmed lapse/i);
  });

  it('does not describe confirmed-lapse OAuth identities as revoked', () => {
    for (const doc of [mcpOverview, apiOauth]) {
      assert.match(doc, /provider-confirmed[\s\S]{0,220}(?:restricted|allowance-metered)[\s\S]{0,80}free-account/i);
      assert.match(doc, /expired or disabled[\s\S]{0,180}(?:denied|deny)/i);
      assert.doesNotMatch(doc, /(?:subscription )?downgrade revokes (?:OAuth )?MCP access/i);
      assert.doesNotMatch(doc, /a downgrade revokes access on the next request/i);
    }
  });

  it('distinguishes public bot-gate bypasses from shared-secret machine routes', () => {
    assert.match(usageErrors, /Exact bot-gate bypass paths/i);
    assert.match(usageErrors, /intentionally public[\s\S]*\/api\/version[\s\S]*\/api\/download\.md/i);
    assert.match(usageErrors, /\/api\/seed-contract-probe[\s\S]*x-probe-secret: \$RELAY_SHARED_SECRET/i);
    assert.match(usageErrors, /\/api\/internal\/brief-why-matters[\s\S]*Authorization: Bearer \$RELAY_SHARED_SECRET/i);
    assert.doesNotMatch(usageErrors, /Exact public paths/i);
  });

  it('describes method-aware markdown and social-preview bot-gate carve-outs', () => {
    const callMiddleware = (path, { method = 'GET', userAgent } = {}) => middleware(new Request(
      `https://worldmonitor.app${path}`,
      { method, headers: userAgent ? { 'user-agent': userAgent } : {} },
    ));
    assert.equal(callMiddleware('/api/health.md', { userAgent: 'curl/8.7.1' }), undefined);
    assert.equal(callMiddleware('/api/health.md', { method: 'HEAD', userAgent: 'curl/8.7.1' }), undefined);
    assert.equal(callMiddleware('/api/story', { userAgent: 'Twitterbot/1.0' }), undefined);
    assert.equal(
      callMiddleware('/api/brief/carousel/user_abc/2026-08-24-1200/0', { userAgent: 'TelegramBot/1.0' }),
      undefined,
    );

    assert.match(usageErrors, /`GET`\/`HEAD`[^\n]*markdown twins/i);
    assert.match(usageErrors, /social preview[^\n]*(?:image|carousel)/i);
    assert.doesNotMatch(usageErrors, /Everything else[^\n]*is behind it/i);
  });
});
