import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('API plan-limit notice UI wiring', () => {
  const settings = readFileSync('src/components/UnifiedSettings.ts', 'utf8');
  const service = readFileSync('src/services/api-plan-limit-notices.ts', 'utf8');
  const css = readFileSync('src/styles/main.css', 'utf8');

  it('reads and acknowledges current notices through Convex', () => {
    assert.match(service, /listCurrentPlanLimitNotices/);
    assert.match(service, /apiPlanLimitNotices\.listCurrentForUser/);
    assert.match(service, /acknowledgePlanLimitNotice/);
    assert.match(service, /apiPlanLimitNotices\.acknowledgeNotice/);
  });

  it('renders notices in both API Keys and MCP settings surfaces', () => {
    assert.match(settings, /data-plan-limit-notices/);
    assert.match(settings, /renderPlanLimitNotices/);
    assert.match(settings, /renderApiKeysContent/);
    assert.match(settings, /renderMcpClientsContent/);
  });

  it('routes notice CTAs through billing portal, checkout, or support', () => {
    assert.match(settings, /handlePlanLimitNoticeCta/);
    assert.match(settings, /openBillingPortal/);
    assert.match(settings, /startCheckout/);
    assert.match(settings, /mailto:support@worldmonitor\.app/);
  });

  it('defines bounded responsive notice styles', () => {
    assert.match(css, /\.api-plan-limit-notice/);
    assert.match(css, /flex-wrap: wrap/);
    assert.match(css, /@media \(max-width: 560px\)/);
  });
});
