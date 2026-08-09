/**
 * Full-pipeline diagnostic for issue #6182.
 *
 * Drives the REAL SearchAdapter (Exa discovery + Firecrawl/Exa extraction +
 * strict validator) over every basket item for the given retailers and reports
 * the terminal failure class per item. This is the production path, not a
 * reimplementation, so a verdict here is the verdict the seeder would record.
 *
 * Run: EXA_API_KEYS=... FIRECRAWL_API_KEY=... npx tsx src/adapters/extraction.diag.ts <slug> [slug ...]
 */
import { ExaProvider } from '../acquisition/exa.js';
import { FirecrawlProvider } from '../acquisition/firecrawl.js';
import { loadRetailerConfig } from '../config/loader.js';
import { SearchAdapter, SearchTargetError } from './search.js';
import type { AdapterContext } from './types.js';

const slugs = process.argv.slice(2);
if (slugs.length === 0) {
  console.error('usage: extraction.diag.ts <retailer-slug> [...]');
  process.exit(1);
}

const exaKey = (process.env.EXA_API_KEYS || process.env.EXA_API_KEY || '').split(/[\n,]+/)[0].trim();
const fcKey = process.env.FIRECRAWL_API_KEY ?? '';
if (!exaKey || !fcKey) {
  console.error('Missing EXA_API_KEYS or FIRECRAWL_API_KEY');
  process.exit(1);
}

const captured: string[] = [];
const logger = {
  info: (msg: string) => captured.push(msg),
  warn: (msg: string) => captured.push(`[WARN] ${msg}`),
  error: (msg: string) => captured.push(`[ERR] ${msg}`),
};

interface Row {
  slug: string;
  item: string;
  ok: boolean;
  price?: number;
  reasonClass: string;
  detail: string;
}

const rows: Row[] = [];

for (const slug of slugs) {
  const cfg = loadRetailerConfig(slug);
  // Fresh adapter per retailer: provider cooldowns are scoped to one scrape.
  const adapter = new SearchAdapter(new ExaProvider(exaKey), new FirecrawlProvider(fcKey));
  const ctx: AdapterContext = { config: cfg, logger, runId: `diag-${slug}` };

  console.log(`\n${'='.repeat(78)}\n${slug} (${cfg.name})\n${'='.repeat(78)}`);

  const targets = await adapter.discoverTargets(ctx);
  // Mirror scrape.ts:328 — the real job paces targets by the retailer's
  // configured delay. Without it a bot-sensitive retailer blocks the
  // diagnostic and every page looks like `missing-price`.
  const delay = cfg.rateLimit?.delayBetweenRequestsMs ?? 2_000;
  let first = true;
  for (const target of targets) {
    if (!first) await new Promise((r) => setTimeout(r, delay));
    first = false;
    const canonicalName = String((target.metadata as { canonicalName: string }).canonicalName);
    captured.length = 0;
    try {
      const res = await adapter.fetchTarget(ctx, target);
      const parsed = await adapter.parseListing(ctx, res);
      if (parsed.length === 0) {
        rows.push({ slug, item: canonicalName, ok: false, reasonClass: 'parse-dropped', detail: captured.slice(-2).join(' ; ') });
        console.log(`✗ ${canonicalName.padEnd(32)} parse-dropped`);
        continue;
      }
      const p = parsed[0];
      rows.push({ slug, item: canonicalName, ok: true, price: p.price, reasonClass: 'ok', detail: `${p.rawTitle} | ${p.rawSizeText ?? '-'} | ${p.sourceUrl}` });
      console.log(`✓ ${canonicalName.padEnd(32)} ${p.price} — ${p.rawTitle}  [${p.rawSizeText ?? 'no size'}]`);
    } catch (err) {
      let reasonClass = 'unknown';
      let detail = err instanceof Error ? err.message : String(err);
      if (err instanceof SearchTargetError) {
        const counts = new Map<string, number>();
        for (const f of err.failures) counts.set(f.reason, (counts.get(f.reason) ?? 0) + 1);
        reasonClass = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(',');
        detail = err.failures.map((f) => `${f.provider}:${f.reason}${f.detail ? `(${f.detail})` : ''}`).join(' | ');
      } else if (/failed host\/path check/.test(detail)) {
        reasonClass = 'discovery-filter';
      } else if (/no pages found/.test(detail)) {
        reasonClass = 'discovery-empty';
      }
      rows.push({ slug, item: canonicalName, ok: false, reasonClass, detail });
      console.log(`✗ ${canonicalName.padEnd(32)} ${reasonClass}`);
      console.log(`     ${detail.slice(0, 400)}`);
    }
  }
}

console.log(`\n\n${'#'.repeat(78)}\nSUMMARY\n${'#'.repeat(78)}`);
for (const slug of slugs) {
  const r = rows.filter((x) => x.slug === slug);
  console.log(`\n${slug}: ${r.filter((x) => x.ok).length}/${r.length} pages`);
  const byClass = new Map<string, number>();
  for (const x of r.filter((y) => !y.ok)) byClass.set(x.reasonClass, (byClass.get(x.reasonClass) ?? 0) + 1);
  for (const [k, v] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(2)} × ${k}`);
}

console.log(`\nJSON\n${JSON.stringify(rows, null, 1)}`);
