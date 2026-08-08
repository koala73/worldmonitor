import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('API plan-limit enforcement readiness contract', () => {
  const notices = readFileSync('convex/apiPlanLimitNotices.ts', 'utf8');
  const scanner = readFileSync('convex/apiPlanLimitUsage.ts', 'utf8');
  const schema = readFileSync('convex/schema.ts', 'utf8');
  const usageDocs = readFileSync('docs/usage-rate-limits.mdx', 'utf8');
  const telemetryDocs = readFileSync('docs/architecture/usage-telemetry.md', 'utf8');

  it('keeps scanner and readiness functions internal-only', () => {
    assert.match(scanner, /export const scanApiPlanLimitUsageInternal = internalAction/);
    assert.doesNotMatch(scanner, /export const scanApiPlanLimitUsage = action/);
    assert.match(notices, /export const getEnforcementReadiness = internalQuery/);
  });

  it('blocks hard enforcement on missing notice lifecycle proof', () => {
    assert.match(notices, /stale_notice_source/);
    assert.match(notices, /email_pending/);
    assert.match(notices, /email_failed/);
    assert.match(notices, /blockedReason/);
    assert.match(notices, /emailStatusAfterRescan/);
  });

  it('documents no automatic upgrade or overage charge', () => {
    assert.match(usageDocs, /does \*\*not\*\* automatically upgrade/);
    assert.match(usageDocs, /charge for overages/);
    assert.match(usageDocs, /getEnforcementReadiness/);
  });

  it('documents scanner sources and the MCP limiter-hit dependency', () => {
    assert.match(telemetryDocs, /AXIOM_QUERY_TOKEN/);
    assert.match(telemetryDocs, /UPSTASH_REDIS_REST_URL/);
    assert.match(telemetryDocs, /mcp\.rate_limit_hit/);
    assert.match(telemetryDocs, /does not assume zero usage/);
    assert.match(scanner, /tag == "mcp\.toolcall"/);
    assert.match(scanner, /tag == "mcp\.rate_limit_hit"/);
    assert.match(schema, /index\("by_validUntil", \["validUntil"\]\)/);
  });
});
