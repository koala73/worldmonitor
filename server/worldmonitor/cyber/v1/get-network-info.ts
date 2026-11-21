import type { GetNetworkInfoRequest, GetNetworkInfoResponse, ServerContext } from '../../../../src/generated/server/worldmonitor/cyber/v1/service_server';
import { cachedFetchJsonWithMeta } from '../../../_shared/redis';
import { checkScopedRateLimit, getClientRateLimitKey } from '../../../_shared/rate-limit';
import { isBlockedResolvedAddress } from '../../../_shared/ip-address-classification';

function publicIp(input: string): string | null {
  if (!input || input.length > 45) return null;
  let ip: string;
  if (input.includes(':') && /^[\da-f:.]+$/i.test(input)) {
    try { ip = new URL(`http://[${input}]`).hostname.slice(1, -1); } catch { return null; }
  } else if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(input)
    && input.split('.').every(part => Number(part) <= 255)) {
    ip = input;
  } else return null;
  return isBlockedResolvedAddress(ip) ? null : ip;
}

class ProviderBudgetError extends Error {
  constructor(message: string, readonly callerLocal = false) {
    super(message);
    this.name = 'ProviderBudgetError';
  }
}

const text = (value: unknown, max = 256): string => typeof value === 'string' ? value.trim().slice(0, max) : '';

async function ripe(endpoint: string, ip: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const url = new URL(`https://stat.ripe.net/data/${endpoint}/data.json`);
  url.searchParams.set('resource', ip);
  url.searchParams.set('sourceapp', 'worldmonitor');
  const response = await fetch(url.toString(), {
    headers: { 'User-Agent': 'WorldMonitor/2.0 (https://www.worldmonitor.app)', Accept: 'application/json' },
    redirect: 'error', signal,
  });
  if (!response.ok) throw new Error('RIPEstat unavailable');
  const body: { status?: unknown; data?: unknown } = await response.json();
  if (body.status !== 'ok' || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    throw new Error('RIPEstat invalid response');
  }
  return body.data as Record<string, unknown>;
}

export async function getNetworkInfo(ctx: ServerContext, req: GetNetworkInfoRequest): Promise<GetNetworkInfoResponse> {
  const empty = (status: string, ip = ''): GetNetworkInfoResponse => ({
    status, ip, asns: [], prefix: '', isLessSpecific: false, hostnames: [], lookupAt: '', routingAt: '',
  });
  const ip = publicIp(req.ip);
  if (!ip) return empty('invalid');
  // RIPEstat terms 3.3 require written permission for commercial reuse.
  // Also gates cached results, so removing authorization takes effect immediately.
  if (process.env.RIPESTAT_NETWORK_INFO_ENABLED !== 'true') return empty('disabled', ip);
  try {
    const { data: result } = await cachedFetchJsonWithMeta<GetNetworkInfoResponse>(`cyber:network:v1:${ip}`, 86400, async () => {
      // A caller cannot consume the deployment's entire provider allowance.
      const callerBudget = await checkScopedRateLimit('cyber-network-provider:caller', 6, '1 h', getClientRateLimitKey(ctx.request));
      if (!callerBudget.allowed || callerBudget.degraded) throw new ProviderBudgetError('Caller provider budget unavailable', true);
      // Two requests per lookup; <=8 concurrent and <=900/day globally. Fail
      // closed on missing Redis or degraded decisions; cache hits use no budget.
      for (const [limit, window] of [[4, '60 s'], [450, '1 d']] as const) {
        const budget = await checkScopedRateLimit(`cyber-network-provider:${window}`, limit, window, 'global');
        if (!budget.allowed || budget.degraded) throw new ProviderBudgetError('Network provider budget unavailable');
      }
      const signal = AbortSignal.timeout(5000);
      const [routing, dns] = await Promise.allSettled([
        ripe('prefix-overview', ip, signal), ripe('reverse-dns-ip', ip, signal),
      ]);
      const network = routing.status === 'fulfilled' ? routing.value : null;
      const reverse = dns.status === 'fulfilled' && Array.isArray(dns.value.result) && dns.value.result.every(name => typeof name === 'string') && typeof dns.value.error === 'string' ? dns.value : null;
      // A valid empty array is no data; a missing/wrong-typed array is a failure.
      const validRouting = network && Array.isArray(network.asns) && network.asns.every(origin =>
        origin && typeof origin === 'object' && Number.isInteger(origin.asn) && origin.asn > 0 && origin.asn <= 4294967295);
      const asns = validRouting
        ? (network.asns as Array<{ asn: number; holder?: unknown }>).map(origin => ({ asn: origin.asn, holder: text(origin.holder) }))
        : [];
      const hostnames = reverse && !reverse.error
        ? (reverse.result as string[]).map(name => name.trim().replace(/\.$/, '')).filter(name => name.length > 0 && name.length <= 253)
        : [];
      const prefix = validRouting ? text(network.resource, 80) : '';
      const routingTime = validRouting ? text(network.query_time, 40) : '';
      const routingDate = routingTime ? new Date(/Z$|[+-]\d\d:\d\d$/.test(routingTime) ? routingTime : `${routingTime}Z`) : null;
      const hasData = asns.length > 0 || !!prefix || hostnames.length > 0;
      let status = hasData ? 'available' : 'no_data';
      const dnsUnavailable = !reverse || (!!reverse.error && !/NXDOMAIN|does not exist/i.test(text(reverse.error)));
      if (!validRouting || dnsUnavailable) {
        console.warn('[cyber-network-provider] incomplete lookup', {
          routing: validRouting ? 'ok' : 'unavailable', reverseDns: dnsUnavailable ? 'unavailable' : 'ok',
        });
        // A status string is not a shared cache no-store marker. Return null
        // when no useful data survived so failures get only the short cooldown.
        if (!hasData) return null;
        status = 'partial';
      }
      return {
        ...empty(status, ip),
        asns, prefix, hostnames, isLessSpecific: validRouting ? network.is_less_specific === true : false,
        lookupAt: new Date().toISOString(),
        routingAt: routingDate && Number.isFinite(routingDate.getTime()) ? routingDate.toISOString() : '',
      };
    }, 120, {
      timeoutMs: 12000, cacheUpstreamUnavailablePayloads: false,
      // A caller's refusal must not poison another caller's shared IP cache or
      // coalesced request. The helper retries followers under their own budget.
      isCallerLocalError: error => error instanceof ProviderBudgetError && error.callerLocal,
    });
    return result ?? empty('unavailable', ip);
  } catch (error) {
    return empty(error instanceof ProviderBudgetError ? 'rate_limited' : 'unavailable', ip);
  }
}
