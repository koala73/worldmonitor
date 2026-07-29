import type {
  GetChinaDecisionSignalsRequest,
  GetChinaDecisionSignalsResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import {
  composeChinaDecisionSignals,
  type ChinaDecisionSignalSnapshot,
} from '../../../../shared/china-decision-signals';
import { getCachedJsonBatch } from '../../../_shared/redis';
import { getChinaMacroSnapshot } from '../../economic/v1/get-china-macro-snapshot';
import { getChinaActivityNowcast } from '../../economic/v1/get-china-activity-nowcast';
import { resolveChinaCorridorSnapshot } from '../../supply-chain/v1/get-china-corridor-control-towers';

export const CHINA_DECISION_SIGNAL_SOURCE_KEYS = Object.freeze({
  policy: 'china:policy-events:v1',
  crossStrait: 'military:cross-strait-activity:v1',
  corporate: 'market:china:corporate-disclosures:v1',
});

type BatchReader = (
  keys: string[],
  raw?: boolean,
) => Promise<Map<string, unknown>>;

export interface ChinaDecisionSignalDependencies {
  now: () => string;
  readBatch: BatchReader;
  getMacro: (ctx: ServerContext) => Promise<unknown>;
  getCorridors: (generatedAt: string) => Promise<unknown>;
  getNowcast: (ctx: ServerContext) => Promise<unknown>;
}

const defaultDependencies: ChinaDecisionSignalDependencies = {
  now: () => new Date().toISOString(),
  readBatch: getCachedJsonBatch,
  getMacro: (ctx) => getChinaMacroSnapshot(ctx, {}),
  getCorridors: (generatedAt) => resolveChinaCorridorSnapshot(generatedAt),
  getNowcast: async (ctx) => {
    const response = await getChinaActivityNowcast(ctx, {});
    try {
      return JSON.parse(response.payloadJson) as unknown;
    } catch {
      return null;
    }
  },
};

async function settledValue<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

export async function resolveChinaDecisionSignalSnapshot(
  ctx: ServerContext,
  dependencies: ChinaDecisionSignalDependencies = defaultDependencies,
): Promise<ChinaDecisionSignalSnapshot> {
  const generatedAt = dependencies.now();
  const [sourceBatch, macro, corridors, nowcast] = await Promise.all([
    settledValue(dependencies.readBatch(
      Object.values(CHINA_DECISION_SIGNAL_SOURCE_KEYS),
      true,
    )),
    settledValue(dependencies.getMacro(ctx)),
    settledValue(dependencies.getCorridors(generatedAt)),
    settledValue(dependencies.getNowcast(ctx)),
  ]);
  return composeChinaDecisionSignals({
    generatedAt,
    macro,
    policy: sourceBatch?.get(CHINA_DECISION_SIGNAL_SOURCE_KEYS.policy) ?? null,
    crossStrait: sourceBatch?.get(CHINA_DECISION_SIGNAL_SOURCE_KEYS.crossStrait) ?? null,
    corporate: sourceBatch?.get(CHINA_DECISION_SIGNAL_SOURCE_KEYS.corporate) ?? null,
    corridors,
    nowcast,
  });
}

export function projectChinaDecisionSignalWireResponse(
  snapshot: ChinaDecisionSignalSnapshot,
): GetChinaDecisionSignalsResponse {
  return {
    payloadJson: JSON.stringify(snapshot),
    generatedAt: snapshot.generatedAt,
    upstreamUnavailable: snapshot.groups.every((group) => group.state === 'unavailable'),
  };
}

export async function getChinaDecisionSignals(
  ctx: ServerContext,
  _req: GetChinaDecisionSignalsRequest,
): Promise<GetChinaDecisionSignalsResponse> {
  return projectChinaDecisionSignalWireResponse(
    await resolveChinaDecisionSignalSnapshot(ctx),
  );
}
