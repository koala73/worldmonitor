/**
 * Discovery-only diagnostic for issue #6182.
 *
 * For every (retailer, basket item) pair, runs the REAL Exa discovery call the
 * scrape would run, then replays each configured filter stage separately so a
 * lost page can be attributed to host / urlPathContains / urlPathMustContain
 * rather than to "extraction failed". No Firecrawl calls, so this is cheap
 * enough to run across the whole priority set.
 *
 * Run: EXA_API_KEYS=... npx tsx src/adapters/discovery.diag.ts [slug ...]
 */
import { ExaProvider } from '../acquisition/exa.js';
import { loadAllBasketConfigs, loadRetailerConfig } from '../config/loader.js';
import { MARKET_NAMES } from './market-names.js';
import {
  buildExaDiscoveryRequest,
  isAllowedHost,
  matchesAnyPathFilter,
  matchesRequiredPathSegments,
  normalizeAllowedHosts,
  normalizePathFilters,
} from './search.js';

const DEFAULT_SLUGS = ['jiomart_in', 'noon_grocery_ae', 'noon_sa', 'carrefour_sa', 'coldstorage_sg'];
const slugs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SLUGS;

const exaKey = (process.env.EXA_API_KEYS || process.env.EXA_API_KEY || '').split(/[\n,]+/)[0].trim();
if (!exaKey) {
  console.error('Missing EXA_API_KEYS / EXA_API_KEY');
  process.exit(1);
}
const exa = new ExaProvider(exaKey);

interface Row {
  slug: string;
  item: string;
  returned: number;
  hostOk: number;
  pathOk: number;
  segOk: number;
  verdict: string;
  rejected: string[];
}

const rows: Row[] = [];

for (const slug of slugs) {
  const cfg = loadRetailerConfig(slug);
  const sc = cfg.searchConfig;
  const domain = new URL(cfg.baseUrl).hostname;
  const hosts = normalizeAllowedHosts(domain, sc?.allowedHosts);
  const pathFilters = normalizePathFilters(sc?.urlPathContains);
  const segments = sc?.urlPathMustContain ?? [];
  const marketName = MARKET_NAMES[cfg.marketCode] ?? cfg.marketCode.toUpperCase();
  const baskets = loadAllBasketConfigs().filter((b) => b.marketCode === cfg.marketCode);

  console.log(`\n${'='.repeat(78)}`);
  console.log(`${slug}  hosts=[${hosts.join(', ')}]  path=[${pathFilters.join(', ') || '<none>'}]  required=[${segments.join('+') || '<none>'}]`);
  console.log('='.repeat(78));

  for (const basket of baskets) {
    for (const item of basket.items) {
      const request = buildExaDiscoveryRequest({
        searchConfig: sc,
        canonicalName: item.canonicalName,
        category: item.category,
        currency: cfg.currencyCode,
        marketName,
        includeDomains: hosts,
      });

      let urls: string[] = [];
      let err: string | null = null;
      try {
        const res = await exa.search(request.query, request.options);
        urls = res.map((r) => r.url).filter(Boolean);
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }

      if (err) {
        rows.push({ slug, item: item.canonicalName, returned: -1, hostOk: 0, pathOk: 0, segOk: 0, verdict: 'EXA_ERROR', rejected: [err] });
        console.log(`  ${item.canonicalName.padEnd(34)} EXA_ERROR ${err.slice(0, 90)}`);
        continue;
      }

      const hostOk = urls.filter((u) => isAllowedHost(u, hosts));
      const pathOk = hostOk.filter((u) => matchesAnyPathFilter(u, pathFilters));
      const segOk = pathOk.filter((u) => matchesRequiredPathSegments(u, segments));

      let verdict: string;
      if (urls.length === 0) verdict = 'NO_RESULTS';
      else if (hostOk.length === 0) verdict = 'HOST_FILTER';
      else if (pathOk.length === 0) verdict = 'PATH_FILTER';
      else if (segOk.length === 0) verdict = 'SEGMENT_FILTER';
      else verdict = 'PASS';

      const rejected = urls.filter((u) => !segOk.includes(u)).slice(0, 5);
      rows.push({ slug, item: item.canonicalName, returned: urls.length, hostOk: hostOk.length, pathOk: pathOk.length, segOk: segOk.length, verdict, rejected });

      const flag = verdict === 'PASS' ? ' ' : '!';
      console.log(`${flag} ${item.canonicalName.padEnd(34)} exa=${urls.length} host=${hostOk.length} path=${pathOk.length} seg=${segOk.length}  ${verdict}`);
      if (verdict !== 'PASS' && rejected.length > 0) {
        for (const u of rejected) console.log(`      rejected: ${u}`);
      }
      if (verdict === 'PASS') {
        console.log(`      kept: ${segOk[0]}`);
      }
    }
  }
}

console.log(`\n\n${'#'.repeat(78)}\nSUMMARY\n${'#'.repeat(78)}`);
for (const slug of slugs) {
  const r = rows.filter((x) => x.slug === slug);
  const pass = r.filter((x) => x.verdict === 'PASS').length;
  const byVerdict = new Map<string, number>();
  for (const x of r) byVerdict.set(x.verdict, (byVerdict.get(x.verdict) ?? 0) + 1);
  const breakdown = [...byVerdict.entries()].map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`${slug.padEnd(18)} discovery ${pass}/${r.length}   ${breakdown}`);
}

console.log('\nJSON');
console.log(JSON.stringify(rows, null, 1));
