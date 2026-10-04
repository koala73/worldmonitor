import { COUNTRY_READERS, countryReadResultSchema, type CountryReader } from '../../shared/country-brief-host';
import { CountrySectionError } from './country-brief-error';
export { CountrySectionError } from './country-brief-error';

const REUSE_MS = 300_000;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES = 524288;
type CachedRead = { text: string; expires: number; bytes: number };
type PendingRead = { promise: Promise<string>; controller: AbortController; users: number; settled: boolean };

export function createHostCountryFetch(call: (name: string, args: object, signal: AbortSignal) => Promise<unknown>) {
  let active = 0;
  let cacheBytes = 0;
  const queue: Array<() => void> = [];
  const cache = new Map<string, CachedRead>();
  const pending = new Map<string, PendingRead>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://www.worldmonitor.app' || (init?.method ?? (input instanceof Request ? input.method : 'GET')) !== 'GET') throw new Error('Unsupported country request');
    const entry = Object.entries(COUNTRY_READERS).find(([, reader]) => reader.path === url.pathname && reader.args.safeParse(Object.fromEntries(url.searchParams)).success);
    if (!entry) throw new Error('Unsupported country reader');
    const [section, reader] = entry;
    const args = reader.args.parse(Object.fromEntries(url.searchParams));
    const signal = init?.signal ?? (input instanceof Request ? input.signal : new AbortController().signal);
    signal.throwIfAborted();
    const key = JSON.stringify([section, Object.entries(args).sort(([a], [b]) => a.localeCompare(b))]);
    const stored = cache.get(key);
    if (stored && stored.expires > Date.now()) return new Response(stored.text, { headers: { 'Content-Type': 'application/json' } });
    if (stored) { cache.delete(key); cacheBytes -= stored.bytes; }
    let work = pending.get(key);
    if (!work) {
      const controller = new AbortController();
      work = { controller, users: 0, settled: false, promise: Promise.resolve('') };
      const ownedWork = work;
      work.promise = (async () => {
        const requestSignal = controller.signal;
        if (active >= 3) await new Promise<void>((resolve, reject) => {
          const start = () => { active++; requestSignal.removeEventListener('abort', abort); resolve(); };
          const abort = () => { const index = queue.indexOf(start); if (index >= 0) queue.splice(index, 1); reject(requestSignal.reason); };
          queue.push(start);
          requestSignal.addEventListener('abort', abort, { once: true });
        });
        else active++;
        try {
          requestSignal.throwIfAborted();
          const raw = await call('get_country_brief_section', { section, arguments: args }, requestSignal);
          const result = countryReadResultSchema.parse(raw);
          if (result.section !== section as CountryReader) throw new Error('Country section identity mismatch');
          if (result.state !== 'ready') throw new CountrySectionError(result.state, result.reason);
          const requestedCountry = 'country_code' in args ? args.country_code : 'countryCode' in args ? args.countryCode : 'iso2' in args ? args.iso2 : undefined;
          const returnedCountry = result.value.countryCode ?? result.value.iso2;
          if (requestedCountry && returnedCountry && requestedCountry !== returnedCountry) throw new Error('Country identity mismatch');
          const text = JSON.stringify(result.value);
          const bytes = new TextEncoder().encode(text).length;
          if (bytes <= MAX_ENTRY_BYTES && !requestSignal.aborted && result.value.upstreamUnavailable !== true
            && !(Array.isArray(result.value.missing) && result.value.missing.length)) {
            while (cacheBytes + bytes > MAX_CACHE_BYTES && cache.size) {
              const oldest = cache.keys().next().value!;
              cacheBytes -= cache.get(oldest)!.bytes;
              cache.delete(oldest);
            }
            cache.set(key, { text, bytes, expires: Date.now() + REUSE_MS });
            cacheBytes += bytes;
          }
          return text;
        } finally { active--; queue.shift()?.(); }
      })().finally(() => {
        ownedWork.settled = true;
        if (pending.get(key) === ownedWork) pending.delete(key);
      });
      pending.set(key, work);
    }
    const subscribed = work;
    subscribed.users++;
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        subscribed.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
      return new Response(text, { headers: { 'Content-Type': 'application/json' } });
    } finally {
      subscribed.users--;
      if (!subscribed.users && !subscribed.settled) {
        if (pending.get(key) === subscribed) pending.delete(key);
        subscribed.controller.abort();
      }
    }
  };
  const clear = () => {
    cache.clear(); cacheBytes = 0;
    for (const work of pending.values()) work.controller.abort();
    pending.clear();
  };
  return Object.assign(fetcher, { clear });
}
