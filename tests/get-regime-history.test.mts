import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adaptTransition } from '../server/worldmonitor/intelligence/v1/get-regime-history';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const handlerSrc = readFileSync(
  resolve(root, 'server/worldmonitor/intelligence/v1/get-regime-history.ts'),
  'utf-8',
);

const handlerIndexSrc = readFileSync(
  resolve(root, 'server/worldmonitor/intelligence/v1/handler.ts'),
  'utf-8',
);

const premiumPathsSrc = readFileSync(
  resolve(root, 'src/shared/premium-paths.ts'),
  'utf-8',
);

const gatewaySrc = readFileSync(
  resolve(root, 'server/gateway.ts'),
  'utf-8',
);

const protoSrc = readFileSync(
  resolve(root, 'proto/worldmonitor/intelligence/v1/get_regime_history.proto'),
  'utf-8',
);

const serviceProtoSrc = readFileSync(
  resolve(root, 'proto/worldmonitor/intelligence/v1/service.proto'),
  'utf-8',
);

// ────────────────────────────────────────────────────────────────────────────
// adaptTransition: snake_case → camelCase adapter (the substantive logic)
// ────────────────────────────────────────────────────────────────────────────

describe('adaptTransition', () => {
  it('maps all fields from persisted shape to proto shape', () => {
    const result = adaptTransition({
      region_id: 'mena',
      label: 'coercive_stalemate',
      previous_label: 'calm',
      transitioned_at: 1_700_000_000_000,
      transition_driver: 'cross_source_surge',
      snapshot_id: 'snap-mena-42',
    });
    assert.equal(result.regionId, 'mena');
    assert.equal(result.label, 'coercive_stalemate');
    assert.equal(result.previousLabel, 'calm');
    assert.equal(result.transitionedAt, 1_700_000_000_000);
    assert.equal(result.transitionDriver, 'cross_source_surge');
    assert.equal(result.snapshotId, 'snap-mena-42');
  });

  it('coerces missing optional fields to empty strings / zero', () => {
    const result = adaptTransition({ label: 'calm' });
    assert.equal(result.regionId, '');
    assert.equal(result.label, 'calm');
    assert.equal(result.previousLabel, '');
    assert.equal(result.transitionedAt, 0);
    assert.equal(result.transitionDriver, '');
    assert.equal(result.snapshotId, '');
  });

  it('preserves the first-ever transition shape (empty previous_label)', () => {
    const result = adaptTransition({
      region_id: 'east-asia',
      label: 'coercive_stalemate',
      previous_label: '',
      transitioned_at: 1_700_000_000_000,
    });
    assert.equal(result.previousLabel, '');
  });

  it('rejects non-numeric transitioned_at', () => {
    // Treat NaN / string input as 0 so proto int64 never sees garbage.
    const result = adaptTransition(/** @type any */ ({ transitioned_at: 'not a number' }));
    assert.equal(result.transitionedAt, 0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Handler structural checks (single-file handler discipline)
// ────────────────────────────────────────────────────────────────────────────

describe('get-regime-history handler structural checks', () => {
  it('reads from the canonical Redis list key prefix', () => {
    assert.match(handlerSrc, /intelligence:regime-history:v1:/);
  });

  it('uses LRANGE against Upstash REST', () => {
    assert.match(handlerSrc, /\/lrange\//);
  });

  it('exports adaptTransition for unit testing', () => {
    assert.match(handlerSrc, /export function adaptTransition/);
  });

  it('exports the handler matching the service interface', () => {
    assert.match(handlerSrc, /export const getRegimeHistory: IntelligenceServiceHandler\['getRegimeHistory'\]/);
  });

  it('enforces a hard cap matching the writer-side LTRIM cap', () => {
    // The handler's MAX_LIMIT must match REGIME_HISTORY_MAX in the writer.
    assert.match(handlerSrc, /MAX_LIMIT\s*=\s*100/);
  });

  it('returns empty response on missing regionId (no Redis call)', () => {
    assert.match(handlerSrc, /if \(!regionId \|\| typeof regionId !== 'string'\)/);
    assert.match(handlerSrc, /return \{ transitions: \[\] \}/);
  });

  it('filters malformed JSON entries from the LRANGE result', () => {
    assert.match(handlerSrc, /dropped malformed entry/);
  });

  it('signals upstreamUnavailable on Redis failure so the gateway skips caching', () => {
    assert.match(handlerSrc, /upstreamUnavailable:\s*true/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Handler registration
// ────────────────────────────────────────────────────────────────────────────

describe('intelligence handler registration', () => {
  it('imports getRegimeHistory from get-regime-history module', () => {
    assert.match(handlerIndexSrc, /import \{ getRegimeHistory \} from '\.\/get-regime-history'/);
  });

  it('registers getRegimeHistory on the handler object', () => {
    assert.match(handlerIndexSrc, /\s+getRegimeHistory,/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Security wiring
// ────────────────────────────────────────────────────────────────────────────

describe('security wiring', () => {
  it('adds the endpoint to PREMIUM_RPC_PATHS', () => {
    assert.match(premiumPathsSrc, /'\/api\/intelligence\/v1\/get-regime-history'/);
  });

  it('has a RPC_CACHE_TIER entry for route-parity', () => {
    // Route-parity contract: every generated GET route needs an explicit tier.
    assert.match(gatewaySrc, /'\/api\/intelligence\/v1\/get-regime-history':\s*'slow'/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Proto definition
// ────────────────────────────────────────────────────────────────────────────

describe('proto definition', () => {
  it('declares the GetRegimeHistory RPC method in service.proto', () => {
    assert.match(serviceProtoSrc, /rpc GetRegimeHistory\(GetRegimeHistoryRequest\) returns \(GetRegimeHistoryResponse\)/);
  });

  it('imports the new proto file from service.proto', () => {
    assert.match(serviceProtoSrc, /import "worldmonitor\/intelligence\/v1\/get_regime_history\.proto"/);
  });

  it('defines GetRegimeHistoryRequest with region_id + limit', () => {
    assert.match(protoSrc, /message GetRegimeHistoryRequest/);
    assert.match(protoSrc, /string region_id = 1/);
    assert.match(protoSrc, /int32 limit = 2/);
  });

  it('validates region_id as strict lowercase kebab', () => {
    assert.match(
      protoSrc,
      /buf\.validate\.field\)\.string\.pattern = "\^\[a-z\]\[a-z0-9\]\*\(-\[a-z0-9\]\+\)\*\$"/,
    );
  });

  it('caps limit between 0 and 100', () => {
    assert.match(protoSrc, /buf\.validate\.field\)\.int32\.gte = 0/);
    assert.match(protoSrc, /buf\.validate\.field\)\.int32\.lte = 100/);
  });

  it('defines RegimeTransition with all 6 fields', () => {
    assert.match(protoSrc, /message RegimeTransition \{/);
    assert.match(protoSrc, /string region_id = 1/);
    assert.match(protoSrc, /string label = 2/);
    assert.match(protoSrc, /string previous_label = 3/);
    assert.match(protoSrc, /int64 transitioned_at = 4/);
    assert.match(protoSrc, /string transition_driver = 5/);
    assert.match(protoSrc, /string snapshot_id = 6/);
  });

  it('defines GetRegimeHistoryResponse with transitions field', () => {
    assert.match(protoSrc, /message GetRegimeHistoryResponse/);
    assert.match(protoSrc, /repeated RegimeTransition transitions = 1/);
  });
});
