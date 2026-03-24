import type {
  ServerContext,
  ListComtradeFlowsRequest,
  ListComtradeFlowsResponse,
  ComtradeFlowRecord,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';
import { getCachedJsonBatch } from '../../../_shared/redis';

const KEY_PREFIX = 'comtrade:flows';

// Strategic reporters and commodities mirrored from the seed script.
const REPORTERS = ['842', '156', '643', '364', '356', '158'];
const CMD_CODES = ['2709', '2711', '7108', '8542', '9301'];

function isValidCode(c: string): boolean {
  return /^\d{1,10}$/.test(c);
}

export async function listComtradeFlows(
  _ctx: ServerContext,
  req: ListComtradeFlowsRequest,
): Promise<ListComtradeFlowsResponse> {
  try {
    const reporters = req.reporterCode && isValidCode(req.reporterCode) ? [req.reporterCode] : REPORTERS;
    const cmdCodes = req.cmdCode && /^\d{4,6}$/.test(req.cmdCode) ? [req.cmdCode] : CMD_CODES;

    const keys = reporters.flatMap((r) => cmdCodes.map((c) => `${KEY_PREFIX}:${r}:${c}`));
    const batch = await getCachedJsonBatch(keys);

    const flows: ComtradeFlowRecord[] = [];
    let fetchedAt = '';
    let dataFound = false;

    for (const result of batch.values()) {
      if (!result) continue;
      dataFound = true;
      const records = Array.isArray(result) ? result : (result as { flows?: ComtradeFlowRecord[]; fetchedAt?: string }).flows ?? [];
      if (!fetchedAt && (result as { fetchedAt?: string }).fetchedAt) {
        fetchedAt = (result as { fetchedAt: string }).fetchedAt;
      }
      for (const r of records) {
        if (req.anomaliesOnly && !r.isAnomaly) continue;
        flows.push(r as ComtradeFlowRecord);
      }
    }

    if (!dataFound) {
      return { flows: [], fetchedAt, upstreamUnavailable: true };
    }

    flows.sort((a, b) => b.year - a.year || Math.abs(b.yoyChange) - Math.abs(a.yoyChange));

    return { flows, fetchedAt, upstreamUnavailable: false };
  } catch {
    return { flows: [], fetchedAt: '', upstreamUnavailable: true };
  }
}
