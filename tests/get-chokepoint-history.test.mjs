import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const handlerSrc = readFileSync(
  resolve(root, 'server/worldmonitor/supply-chain/v1/get-chokepoint-history.ts'),
  'utf-8',
);
const handlerMapSrc = readFileSync(
  resolve(root, 'server/worldmonitor/supply-chain/v1/handler.ts'),
  'utf-8',
);

describe('get-chokepoint-history handler (source analysis)', () => {
  it('reads from the per-id history key prefix', () => {
    assert.match(handlerSrc, /supply_chain:transit-summaries:history:v1:/);
  });

  it('uses getCachedJson in raw mode (unprefixed key)', () => {
    assert.match(handlerSrc, /getCachedJson\(`\$\{HISTORY_KEY_PREFIX\}\$\{id\}`,\s*true\)/);
  });

  it('validates chokepointId against the canonical set', () => {
    assert.match(handlerSrc, /CANONICAL_CHOKEPOINTS/);
    assert.match(handlerSrc, /VALID_IDS\.has\(id\)/);
  });

  it('returns empty history with fetchedAt=0 on invalid id, missing key, or error', () => {
    // Invalid id branch
    assert.match(handlerSrc, /!id\s*\|\|\s*!VALID_IDS\.has\(id\)/);
    // Missing key / non-array branch
    assert.match(handlerSrc, /!payload\s*\|\|\s*!Array\.isArray\(payload\.history\)/);
    // Catch block returns empty history (all three paths return fetchedAt '0')
    const emptyReturns = [...handlerSrc.matchAll(/fetchedAt:\s*'0'/g)];
    assert.ok(emptyReturns.length >= 3, `expected 3+ fetchedAt:'0' returns, got ${emptyReturns.length}`);
  });

  it('is wired into the SupplyChainService handler map', () => {
    assert.match(handlerMapSrc, /import\s+\{\s*getChokepointHistory\s*\}/);
    assert.match(handlerMapSrc, /\bgetChokepointHistory,/);
  });
});

describe('proto wiring', () => {
  const protoSrc = readFileSync(
    resolve(root, 'proto/worldmonitor/supply_chain/v1/service.proto'),
    'utf-8',
  );
  const historyProto = readFileSync(
    resolve(root, 'proto/worldmonitor/supply_chain/v1/get_chokepoint_history.proto'),
    'utf-8',
  );

  it('service.proto imports and registers GetChokepointHistory', () => {
    assert.match(protoSrc, /import "worldmonitor\/supply_chain\/v1\/get_chokepoint_history\.proto"/);
    assert.match(protoSrc, /rpc GetChokepointHistory\(GetChokepointHistoryRequest\) returns \(GetChokepointHistoryResponse\)/);
    assert.match(protoSrc, /path:\s*"\/get-chokepoint-history",\s*method:\s*HTTP_METHOD_GET/);
  });

  it('GetChokepointHistoryRequest requires chokepoint_id as a query param', () => {
    assert.match(historyProto, /\(buf\.validate\.field\)\.required\s*=\s*true/);
    assert.match(historyProto, /\(sebuf\.http\.query\)\s*=\s*\{name:\s*"chokepointId"\}/);
  });

  it('GetChokepointHistoryResponse carries chokepoint_id, history, fetched_at', () => {
    assert.match(historyProto, /string chokepoint_id\s*=\s*1/);
    assert.match(historyProto, /repeated TransitDayCount history\s*=\s*2/);
    assert.match(historyProto, /int64 fetched_at\s*=\s*3/);
  });
});

describe('Redis timeout observability', () => {
  const redisSrc = readFileSync(resolve(root, 'server/_shared/redis.ts'), 'utf-8');

  it('logs [REDIS-TIMEOUT] with key and timeoutMs on AbortError', () => {
    // Grepable tag that log drains / Sentry-Vercel integration can pick up —
    // before this, large-payload timeouts silently returned null and consumers
    // cached zero-state. See docs/plans/chokepoint-rpc-payload-split.md.
    assert.match(redisSrc, /isTimeout\s*=\s*err instanceof Error && err\.name === 'AbortError'/);
    assert.match(redisSrc, /\[REDIS-TIMEOUT\] getCachedJson key=\$\{key\} timeoutMs=\$\{REDIS_OP_TIMEOUT_MS\}/);
  });
});
