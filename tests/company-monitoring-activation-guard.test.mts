import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { COMPANY_MONITORING_RPC_SCOPES } from '../shared/company-monitoring-contract.ts';
import { PUBLIC_NO_AUTH_RPC_PATHS } from '../server/gateway.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';
import { TIER_GATED_PATHS } from '../server/_shared/entitlement-check.ts';

// ---------------------------------------------------------------------------
// Why this test exists
// ---------------------------------------------------------------------------
//
// Company Monitoring ships as a DARK contract: 10 account-scoped RPCs, a generated
// server, and an OpenAPI surface, but no `api/` gateway file, so nothing routes.
//
// The PR that defined it pre-wired the controls activation needs — `no-store` cache
// tiers for the six reads, fail-closed rate policies for the four mutations — precisely
// so activation cannot be unsafe by omission. Auth is the one control it could not
// pre-wire: `PREMIUM_RPC_PATHS` membership would flip `isPremium`, which resolves these
// paths to the `slow-browser` cache tier and makes the deliberate `no-store` entries
// unreachable; and an entitlement tier number is a product decision, not a review one.
//
// So instead of guessing the registry now, this guard makes the omission impossible to
// ship silently. While the service is dark it passes trivially. The moment #6003 adds
// `api/company-monitoring/v1/[rpc].ts`, it fails unless every RPC path is registered in
// an auth registry — turning "the next author has to remember" into "CI says so".

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PATH = '/api/company-monitoring/v1';
const GATEWAY_FILE = resolve(root, 'api/company-monitoring/v1/[rpc].ts');

function rpcPath(rpcName: string): string {
  // CreateMonitoredCompany -> /api/company-monitoring/v1/create-monitored-company
  const kebab = rpcName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return `${BASE_PATH}/${kebab}`;
}

const RPC_PATHS = Object.keys(COMPANY_MONITORING_RPC_SCOPES).map(rpcPath);

describe('Company Monitoring activation guard', () => {
  it('declares a scope for every RPC', () => {
    assert.equal(RPC_PATHS.length, 10, 'expected 10 Company Monitoring RPCs');
    for (const [rpc, scope] of Object.entries(COMPANY_MONITORING_RPC_SCOPES)) {
      assert.match(
        scope as string,
        /^company_monitoring:(read|write)$/,
        `${rpc} must declare a company_monitoring read/write scope`,
      );
    }
  });

  it('never exposes an account-scoped RPC anonymously', () => {
    // Unconditional: this must hold dark AND live.
    for (const path of RPC_PATHS) {
      assert.ok(
        !PUBLIC_NO_AUTH_RPC_PATHS.has(path),
        `${path} serves account-private data and must never be in PUBLIC_NO_AUTH_RPC_PATHS`,
      );
    }
  });

  it('requires an auth registration for every RPC once the service is routed', () => {
    if (!existsSync(GATEWAY_FILE)) {
      // Still dark — nothing routes, so there is nothing to gate yet.
      return;
    }
    const unregistered = RPC_PATHS.filter(
      (path) => !PREMIUM_RPC_PATHS.has(path) && !TIER_GATED_PATHS.has(path),
    );
    assert.deepEqual(
      unregistered,
      [],
      'Company Monitoring is now routed, so every RPC must be registered in PREMIUM_RPC_PATHS '
        + '(browser Bearer attachment) or TIER_GATED_PATHS (server-side entitlement). '
        + 'Registering also changes cache-tier resolution — re-check the no-store intent in '
        + 'server/gateway.ts RPC_CACHE_TIER when you do.',
    );
  });
});
