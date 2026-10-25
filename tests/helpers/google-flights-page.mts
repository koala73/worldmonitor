import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

export const pageFixture = (name: string) =>
  readFileSync(new URL(`../fixtures/google-flights/${name}`, import.meta.url), 'utf8');

type Row = { price: number; departure?: [number, number]; date?: string; stops?: number; airline?: string };

/** A results page whose `ds:1` block holds the given rows in the live shape. */
export function resultsPage(rows: Row[]) {
  const items = rows.map(({ price, departure = [8, 0], date = '2026-11-15', stops = 0, airline = 'BA' }, index) => {
    const [y, m, d] = date.split('-').map(Number);
    const legs = Array.from({ length: stops + 1 }, (_, leg) => {
      const fl: unknown[] = [];
      fl[3] = leg === 0 ? 'JFK' : 'XXX';
      fl[6] = leg === stops ? 'LHR' : 'XXX';
      fl[8] = departure;
      fl[10] = [20, 0];
      fl[11] = 420;
      fl[20] = [y, m, d];
      fl[21] = [y, m, d];
      fl[22] = [airline, String(100 + index)];
      return fl;
    });
    const fd: unknown[] = [];
    fd[2] = legs;
    fd[9] = 420;
    return [fd, [[null, price]]];
  });
  const data = [null, null, [items], null];
  return `<!doctype html><script>AF_initDataCallback({key: 'ds:1', hash: '9', data:${JSON.stringify(data)}, sideChannel: {}});</script>`;
}

/** Decode the `tfs` parameter of a results-page URL into its filter fields. */
export function decodeTfs(input: string | URL) {
  const bytes = Buffer.from(new URL(String(input)).searchParams.get('tfs')!, 'base64url');
  const read = (buf: Buffer) => {
    const fields: { no: number; value: number | Buffer }[] = [];
    let i = 0;
    const varint = () => { let n = 0; let shift = 0; let b; do { b = buf[i++]!; n |= (b & 127) << shift; shift += 7; } while (b & 128); return n >>> 0; };
    while (i < buf.length) {
      const key = varint();
      if ((key & 7) === 0) fields.push({ no: key >> 3, value: varint() });
      else { const len = varint(); fields.push({ no: key >> 3, value: buf.subarray(i, i + len) }); i += len; }
    }
    return fields;
  };
  const top = read(bytes);
  const str = (b: number | Buffer) => (b as Buffer).toString('utf8');
  const airport = (b: number | Buffer) => str(read(b as Buffer).find(f => f.no === 2)!.value);
  return {
    legs: top.filter(f => f.no === 3).map(({ value }) => {
      const leg = read(value as Buffer);
      return {
        date: str(leg.find(f => f.no === 2)!.value),
        maxStops: leg.find(f => f.no === 5)?.value as number | undefined,
        airlines: leg.filter(f => f.no === 6).map(f => str(f.value)),
        from: airport(leg.find(f => f.no === 13)!.value),
        to: airport(leg.find(f => f.no === 14)!.value),
      };
    }),
    adults: top.filter(f => f.no === 8).length,
    seat: top.find(f => f.no === 9)?.value as number,
    trip: top.find(f => f.no === 19)?.value as number,
  };
}

type RelayResponse = { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void };
type RelayHandler = (req: { url: string }, res: RelayResponse) => Promise<void>;

/** Load the relay's real Google Flights section without starting its daemon. */
export function loadGoogleFlightsRelay(provider: typeof fetch, outcomes: string[] = []) {
  const source = readFileSync(new URL('../../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const start = source.indexOf('// ─── Google Flights ─');
  const end = source.indexOf('// ─── Widget Agent ─', start);
  if (start < 0 || end < start) throw new Error('Google Flights section markers moved');
  return runInNewContext(`${source.slice(start, end)}\n({ search: handleGoogleFlightsSearch, dates: handleGoogleFlightsDates })`, {
    URL, Date, AbortSignal, Buffer, process: { env: {} }, console: { warn() {}, error() {} },
    fetch: provider, incrementRelayMetric() {}, recordRelayOutcome(_route: string, outcome: string) { outcomes.push(outcome); },
  }) as { search: RelayHandler; dates: RelayHandler };
}

/** Route fetches to relay.example through a relay handler; everything else goes to `fallback`. */
export function relayTransport(handler: RelayHandler, fallback: typeof fetch): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'relay.example') return fallback(input, init);
    let status = 200; let headers: Record<string, string> = {}; let body = '';
    await handler({ url: url.pathname + url.search }, { writeHead(code, value) { status = code; headers = value; }, end(value) { body = value; } });
    return new Response(body, { status, headers });
  }) as typeof fetch;
}
