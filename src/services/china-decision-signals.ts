import {
  isChinaDecisionSignalSnapshot,
  type ChinaDecisionSignalSnapshot,
} from '../../shared/china-decision-signals';
import { ensureHydrated } from './bootstrap';
import { IntelligenceServiceClient } from './generated-rpc-clients';
import { getRpcBaseUrl } from './rpc-client';

export const CHINA_DECISION_SIGNAL_HYDRATION_MAX_AGE_MS = 60 * 60 * 1000;
const CHINA_DECISION_SIGNAL_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function isCurrentChinaDecisionSignalSnapshot(
  value: unknown,
  now = Date.now(),
): value is ChinaDecisionSignalSnapshot {
  if (!isChinaDecisionSignalSnapshot(value)) return false;
  const generatedAt = Date.parse(value.generatedAt);
  if (!Number.isFinite(generatedAt)) return false;
  const ageMs = now - generatedAt;
  return ageMs >= -CHINA_DECISION_SIGNAL_FUTURE_SKEW_MS
    && ageMs <= CHINA_DECISION_SIGNAL_HYDRATION_MAX_AGE_MS;
}

export async function getChinaDecisionSignalsData(): Promise<ChinaDecisionSignalSnapshot> {
  const hydrated = await ensureHydrated('chinaDecisionSignals');
  if (isCurrentChinaDecisionSignalSnapshot(hydrated)) return hydrated;

  const client = new IntelligenceServiceClient(getRpcBaseUrl(), {
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
  });
  const response = await client.getChinaDecisionSignals({});
  let payload: unknown;
  try {
    payload = JSON.parse(response.payloadJson);
  } catch {
    throw new Error('China decision-signal API returned invalid JSON');
  }
  if (!isChinaDecisionSignalSnapshot(payload)) {
    throw new Error('China decision-signal API returned an invalid contract');
  }
  return payload;
}
