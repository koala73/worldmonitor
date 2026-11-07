/**
 * Shared helpers for the trade domain RPCs.
 * WTO Timeseries API integration.
 */
import { CHROME_UA } from '../../../_shared/constants';

/** WTO Timeseries API base URL. */
export const WTO_API_BASE = 'https://api.wto.org/timeseries/v1';

/** Merchandise exports (total) — annual. */
export const ITS_MTV_AX = 'ITS_MTV_AX';
/** Merchandise imports (total) — annual. */
export const ITS_MTV_AM = 'ITS_MTV_AM';
/** Simple average MFN applied tariff — all products. */
export const TP_A_0010 = 'TP_A_0010';

/**
 * Fetch JSON from the WTO Timeseries API.
 * Returns parsed JSON on success, or null if the API key is missing or the request fails.
 *
 * IMPORTANT: The WTO API does NOT support comma-separated indicator codes in the `i` param.
 * Each indicator must be queried separately.
 */
export async function wtoFetch(
  path: string,
  params?: Record<string, string>,
): Promise<any | null> {
  const apiKey = process.env.WTO_API_KEY;
  if (!apiKey) {
    console.warn('[WTO] WTO_API_KEY not set in process.env');
    return null;
  }

  try {
    const url = new URL(`${WTO_API_BASE}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'User-Agent': CHROME_UA,
      },
      signal: AbortSignal.timeout(15000),
    });

    // 204 = No Content (valid query, no matching data)
    if (res.status === 204) return { Dataset: [] };
    if (!res.ok) {
      console.warn(`[WTO] HTTP ${res.status} for ${path}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error('[WTO] Fetch error:', e instanceof Error ? e.message : e);
    return null;
  }
}
