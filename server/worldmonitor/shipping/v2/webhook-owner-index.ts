import { ApiError } from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';
import { runRedisPipeline } from '../../../_shared/redis';
import { ownerIndexKey, webhookKey, WEBHOOK_TTL } from './webhook-shared';

const SWEEP_BATCH_SIZE = 100;
const REMOVE_EXPIRED_MEMBER = "if redis.call('EXISTS', KEYS[2]) == 0 then return redis.call('SREM', KEYS[1], ARGV[1]) else return 0 end";

function unavailable(): never {
  throw new ApiError(503, 'Webhook index could not be read or cleaned', '');
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export async function pruneOwnerWebhookIndex(ownerTag: string): Promise<void> {
  const ownerKey = ownerIndexKey(ownerTag);
  const sweepKey = `${ownerKey}:sweep`;
  const stateResult = await runRedisPipeline([['GET', sweepKey]]);
  if (!stateResult[0] || stateResult[0].error) unavailable();
  let state = { cursor: '0', offset: 0 };
  if (stateResult[0].result !== null) {
    if (typeof stateResult[0].result !== 'string') unavailable();
    try {
      const parsed = JSON.parse(stateResult[0].result);
      if (!parsed || typeof parsed.cursor !== 'string' || !/^\d+$/.test(parsed.cursor)
        || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) unavailable();
      state = { cursor: parsed.cursor, offset: parsed.offset };
    } catch { unavailable(); }
  }
  const scan = await runRedisPipeline([['SSCAN', ownerKey, state.cursor, 'COUNT', String(SWEEP_BATCH_SIZE)]]);
  const page = scan[0]?.result;
  if (scan[0]?.error || !Array.isArray(page) || page.length !== 2 || typeof page[0] !== 'string'
    || !/^\d+$/.test(page[0]) || !stringArray(page[1])) unavailable();
  const ids = page[1].slice(state.offset, state.offset + SWEEP_BATCH_SIZE);
  const nextState = state.offset + SWEEP_BATCH_SIZE < page[1].length
    ? { cursor: state.cursor, offset: state.offset + SWEEP_BATCH_SIZE }
    : { cursor: page[0], offset: 0 };
  const records = await runRedisPipeline(ids.map((id) => ['GET', webhookKey(id)]));
  if (records.length !== ids.length || records.some((row) => !row || row.error || (row.result !== null && typeof row.result !== 'string'))) unavailable();
  const expired = ids.filter((_, index) => records[index]?.result === null);
  if (expired.length) {
    const removed = await runRedisPipeline(expired.map((id) => [
      'EVAL', REMOVE_EXPIRED_MEMBER, '2', ownerKey, webhookKey(id), id,
    ]));
    if (removed.length !== expired.length || removed.some((row) => !row || row.error || ![0, 1, '0', '1'].includes(row.result as number | string))) unavailable();
  }
  const saved = await runRedisPipeline([
    ['SET', sweepKey, JSON.stringify(nextState), 'EX', String(WEBHOOK_TTL)],
  ]);
  if (saved[0]?.error || saved[0]?.result !== 'OK') unavailable();
}

export async function readOwnerWebhooks(ownerTag: string): Promise<string[]> {
  await pruneOwnerWebhookIndex(ownerTag);
  const members = await runRedisPipeline([['SMEMBERS', ownerIndexKey(ownerTag)]]);
  const ids = members[0]?.result;
  if (members[0]?.error || !stringArray(ids)) unavailable();
  const records = await runRedisPipeline(ids.map((id) => ['GET', webhookKey(id)]));
  if (records.length !== ids.length || records.some((row) => !row || row.error || (row.result !== null && typeof row.result !== 'string'))) unavailable();
  return records.flatMap((row) => typeof row.result === 'string' ? [row.result] : []);
}
