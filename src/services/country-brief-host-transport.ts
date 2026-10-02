import { COUNTRY_READERS, countryReadResultSchema, type CountryReader } from '../../shared/country-brief-host';

import { CountrySectionError } from './country-brief-error';
export { CountrySectionError } from './country-brief-error';

export function createHostCountryFetch(call: (name: string, args: object, signal: AbortSignal) => Promise<unknown>) {
  let active = 0;
  const queue: Array<() => void> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://www.worldmonitor.app' || (init?.method ?? (input instanceof Request ? input.method : 'GET')) !== 'GET') throw new Error('Unsupported country request');
    const entry = Object.entries(COUNTRY_READERS).find(([, reader]) => reader.path === url.pathname && reader.args.safeParse(Object.fromEntries(url.searchParams)).success);
    if (!entry) throw new Error('Unsupported country reader');
    const [section, reader] = entry;
    const args = reader.args.parse(Object.fromEntries(url.searchParams));
    const signal = init?.signal ?? (input instanceof Request ? input.signal : new AbortController().signal);
    signal.throwIfAborted();
    if (active >= 3) await new Promise<void>((resolve, reject) => {
      const start = () => { active++; signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { const index = queue.indexOf(start); if (index >= 0) queue.splice(index, 1); reject(signal.reason); };
      queue.push(start);
      signal.addEventListener('abort', abort, { once: true });
    });
    else active++;
    try {
      signal.throwIfAborted();
      const raw = await call('get_country_brief_section', { section, arguments: args }, signal);
      const result = countryReadResultSchema.parse(raw);
      if (result.section !== section as CountryReader) throw new Error('Country section identity mismatch');
      if (result.state !== 'ready') throw new CountrySectionError(result.state, result.reason);
      const requestedCountry = 'country_code' in args ? args.country_code : 'countryCode' in args ? args.countryCode : 'iso2' in args ? args.iso2 : undefined;
      const returnedCountry = result.value.countryCode ?? result.value.iso2;
      if (requestedCountry && returnedCountry && requestedCountry !== returnedCountry) throw new Error('Country identity mismatch');
      return new Response(JSON.stringify(result.value), { headers: { 'Content-Type': 'application/json' } });
    } finally {
      active--;
      queue.shift()?.();
    }
  };
  return fetcher;
}
