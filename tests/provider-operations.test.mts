import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROVIDER_OPERATIONS,
  __resetProviderOperationsForTests,
  evaluateProviderOperationReadiness,
  getProviderOperationAuditEvents,
  getProviderOperationsSnapshot,
  recordScheduledRefreshOutcome,
  registerProviderOperationExecutor,
  retryProviderOperation,
  type ProviderOperationId,
} from '../src/services/provider-operations.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = (relativePath: string): string => readFileSync(resolve(root, relativePath), 'utf8');

function operation(id: ProviderOperationId) {
  const found = PROVIDER_OPERATIONS.find(candidate => candidate.id === id);
  assert.ok(found, `missing operation ${id}`);
  return found;
}

describe('Phase 9 Provider Operations control contract', () => {
  it('defines the required stock, news, AIS, PortWatch, trade, customs and model operations with idempotency and locks', () => {
    const ids = PROVIDER_OPERATIONS.map(item => item.id);
    for (const id of [
      'market-rest-gap-repair',
      'market-minute-stream',
      'news-ingest',
      'news-analysis-layer1',
      'ais-relay',
      'portwatch-batch',
      'comtrade-batch',
      'china-customs-import',
      'model-evaluation',
    ] satisfies ProviderOperationId[]) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
    assert.equal(new Set(ids).size, ids.length, 'operation ids must remain unique');
    for (const item of PROVIDER_OPERATIONS) {
      assert.ok(item.idempotencyScope.length > 8, `${item.id} needs an idempotency scope`);
      assert.ok(item.lockScope.length > 4, `${item.id} needs a lock scope`);
      assert.ok(item.minimumRetryIntervalMs >= 15_000, `${item.id} needs bounded retries`);
      assert.ok(item.safetyBoundary.length > 20, `${item.id} needs a truth boundary`);
    }
  });

  it('distinguishes web server opacity, missing desktop configuration, invalid configuration and an executor-ready no-secret import', () => {
    const empty = new Map();
    const market = operation('market-rest-gap-repair');
    assert.equal(evaluateProviderOperationReadiness(market, { desktop: false, secretStatuses: empty }), 'SERVER_MANAGED_UNKNOWN');
    assert.equal(evaluateProviderOperationReadiness(market, { desktop: true, secretStatuses: empty }), 'NOT_CONFIGURED');
    const invalid = new Map([['FINNHUB_API_KEY', { present: true, valid: false }]]);
    assert.equal(evaluateProviderOperationReadiness(market, { desktop: true, secretStatuses: invalid }), 'CONFIG_INVALID');

    const customs = operation('china-customs-import');
    assert.equal(evaluateProviderOperationReadiness(customs, { desktop: true, secretStatuses: empty }), 'NOT_CONFIGURED');
    const unregister = registerProviderOperationExecutor('china-customs-import', async () => ({ outcome: 'success', message: 'imported' }));
    assert.equal(evaluateProviderOperationReadiness(customs, { desktop: true, secretStatuses: empty }), 'READY_TO_ATTEMPT');
    unregister();

    const model = operation('model-evaluation');
    const groqOnly = new Map([['GROQ_API_KEY', { present: true, valid: true }]]);
    assert.equal(evaluateProviderOperationReadiness(model, { desktop: true, secretStatuses: groqOnly }), 'READY_TO_ATTEMPT');
  });

  it('fails closed for a safe retry without a configured/registered executor and records the fact without a provider call', async () => {
    __resetProviderOperationsForTests();
    const outcome = await retryProviderOperation('comtrade-batch', 1_700_000_000_000);
    assert.equal(outcome, 'NOT_CONFIGURED');
    const event = getProviderOperationAuditEvents()[0];
    assert.equal(event?.operationId, 'comtrade-batch');
    assert.equal(event?.outcome, 'NOT_CONFIGURED');
    assert.match(event?.message ?? '', /not executed/i);
  });

  it('keeps scheduler completion distinct from a Provider success and does not silently invent a data result', () => {
    __resetProviderOperationsForTests();
    recordScheduledRefreshOutcome('markets', true, 1_700_000_000_000);
    const market = getProviderOperationsSnapshot().find(item => item.id === 'market-rest-gap-repair');
    assert.equal(market?.telemetry.lastSchedulerCompletionAt, 1_700_000_000_000);
    assert.equal(market?.telemetry.lastExecutorSuccessAt, undefined);
    assert.match(market?.telemetry.lastMessage ?? '', /Provider result remains separately observable/);
  });

  it('uses an owned route/control surface and forces sidecar cloud fallback off in explicit self-hosted mode', () => {
    const main = source('src/main.ts');
    const control = source('src/features/provider-operations/provider-operations.ts');
    const sidecar = source('src-tauri/sidecar/local-api-server.mjs');
    const scheduler = source('src/app/refresh-scheduler.ts');

    assert.match(main, /isProviderOperationsPath/);
    assert.match(main, /initProviderOperationsWorkspace/);
    assert.match(control, /不读取、显示、散列或传递任何密钥/);
    assert.doesNotMatch(control, /iframe/i);
    assert.match(sidecar, /process\.env\.SELF_HOSTED_MODE/);
    assert.match(sidecar, /const cloudFallback = selfHostedMode \? false : requestedFallback/);
    assert.match(sidecar, /localAdminAuthRequired: true/);
    assert.match(scheduler, /recordScheduledRefreshOutcome\(name, result !== false\)/);
  });
});
