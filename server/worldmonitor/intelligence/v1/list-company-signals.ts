/**
 * RPC: listCompanySignals — classified company signals from authoritative
 * sources (issue #5695): SEC 8-K material events (tier 1) and recent news
 * mentions (tier 3). Finnhub fiscal period ends remain enrichment facts; the
 * endpoint does not misstate them as event timestamps.
 *
 * Identity resolves exclusively through the SEC ticker/name registry
 * (server/_shared/sec-edgar) — no keyword or domain-slug guessing (the unsound
 * heuristics removed in issues #3754/#3755, PR #3777). Engagement metrics are
 * intentionally omitted: none of these sources provide real engagement data.
 */

import type {
  ServerContext,
  CompanySignal,
  ListCompanySignalsRequest,
  ListCompanySignalsResponse,
  SignalSummary,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import {
  MATERIAL_8K_ITEMS,
  describeItemCodes,
  fetchSecSubmissions,
  filingIndexUrl,
  resolveCompany,
} from '../../../_shared/sec-edgar';
import { fetchCompanyNewsMentions } from './_company-shared';

const FILING_SIGNAL_WINDOW_MS = 90 * 24 * 3600 * 1000;
const MAX_SIGNALS = 30;

// 8-K item code → signal classification for the highest-value disclosures.
// Anything else material falls back to "Material Event".
const SIGNAL_TYPE_BY_ITEM: Record<string, string> = {
  '1.01': 'M&A / Agreement',
  '1.02': 'M&A / Agreement',
  '1.03': 'Bankruptcy',
  '1.05': 'Cybersecurity Incident',
  '2.01': 'M&A / Agreement',
  '2.02': 'Financial Results',
  '2.04': 'Debt Acceleration',
  '2.06': 'Impairment',
  '3.01': 'Delisting Risk',
  '4.01': 'Accountant Change',
  '4.02': 'Restatement',
  '5.01': 'Control Change',
  '5.02': 'Executive Change',
};

export async function listCompanySignals(
  _ctx: ServerContext,
  req: ListCompanySignalsRequest,
): Promise<ListCompanySignalsResponse> {
  const company = req.company?.trim();
  const domain = req.domain?.trim().toLowerCase();
  const ticker = req.ticker?.trim();

  // Preserve the disabled v1 domain contract. Domain-derived attribution is
  // still forbidden; callers using that deprecated field get an empty stub.
  if (domain) return emptyResponse(company || '', false, domain);

  if (!company && !ticker) {
    throw new ValidationError([{ field: 'company', description: 'Provide ticker or company' }]);
  }

  const resolution = await resolveCompany({ ticker, name: company });
  if (resolution.status !== 'ok') {
    // "not_found" is a real, cacheable answer; "registry_unavailable" is a
    // lookup failure and must not be cached as one.
    return emptyResponse(
      company || ticker?.toUpperCase() || '',
      resolution.status === 'registry_unavailable',
    );
  }
  const resolved = resolution.company;

  const [submissions, news] = await Promise.all([
    fetchSecSubmissions(resolved.cik),
    fetchCompanyNewsMentions(resolved.ticker, resolved.name),
  ]);

  const now = Date.now();
  const signals: CompanySignal[] = [];

  for (const filing of submissions?.filings ?? []) {
    if (!filing.form.startsWith('8-K')) continue;
    const materialItems = filing.items.filter(code => {
      const item = MATERIAL_8K_ITEMS[code];
      return item && item.materiality !== 'routine';
    });
    if (materialItems.length === 0) continue;
    const timestampMs = Date.parse(filing.acceptanceDateTime || filing.filingDate) || 0;
    if (timestampMs === 0 || now - timestampMs > FILING_SIGNAL_WINDOW_MS) continue;
    // A filing like "2.02,5.02" carries both an earnings exhibit and an
    // executive departure; the headline must be the material one, not whichever
    // item code sorts first.
    const primaryItem = (materialItems.find(code => MATERIAL_8K_ITEMS[code]?.materiality === 'high')
      ?? materialItems[0]) as string;
    signals.push({
      type: SIGNAL_TYPE_BY_ITEM[primaryItem] ?? 'Material Event',
      title: `${filing.form}: ${describeItemCodes(materialItems)}`,
      url: filing.accessionNumber ? filingIndexUrl(resolved.cik, filing.accessionNumber) : '',
      source: 'sec_edgar',
      sourceTier: 1,
      timestampMs,
      strength: MATERIAL_8K_ITEMS[primaryItem]?.materiality === 'high' ? 'Strong' : 'Moderate',
      engagement: undefined,
    });
  }

  for (const mention of news?.mentions ?? []) {
    signals.push({
      type: 'News Mention',
      title: mention.title,
      url: mention.url,
      source: mention.source || 'news',
      sourceTier: 3,
      timestampMs: mention.publishedAtMs,
      strength: 'Emerging',
      engagement: undefined,
    });
  }

  signals.sort((a, b) => b.timestampMs - a.timestampMs);
  const bounded = signals.slice(0, MAX_SIGNALS);

  return {
    company: resolved.name,
    domain: '',
    signals: bounded,
    summary: summarize(bounded),
    discoveredAtMs: now,
    cik: resolved.cik,
    // A resolved identity does not make the authoritative filing leg healthy.
    // Keep partial news results, but tell the gateway/consumer that the answer
    // cannot prove the SEC window is quiet (and therefore must not be cached).
    unavailable: submissions == null,
  };
}

function summarize(signals: CompanySignal[]): SignalSummary {
  const byType: Record<string, number> = {};
  const sources = new Set<string>();
  const strengthRank: Record<string, number> = { Strong: 3, Moderate: 2, Emerging: 1, Marginal: 1 };
  let strongest: CompanySignal | undefined;

  for (const signal of signals) {
    byType[signal.type] = (byType[signal.type] ?? 0) + 1;
    sources.add(signal.source);
    if (!strongest
      || (strengthRank[signal.strength] ?? 0) > (strengthRank[strongest.strength] ?? 0)
      || ((strengthRank[signal.strength] ?? 0) === (strengthRank[strongest.strength] ?? 0)
        && (signal.sourceTier < strongest.sourceTier
          || (signal.sourceTier === strongest.sourceTier && signal.timestampMs > strongest.timestampMs)))) {
      strongest = signal;
    }
  }

  return {
    totalSignals: signals.length,
    byType,
    strongestSignal: strongest,
    signalDiversity: sources.size,
  };
}

function emptyResponse(company: string, unavailable = false, domain = ''): ListCompanySignalsResponse {
  return {
    company,
    domain,
    signals: [],
    summary: summarize([]),
    discoveredAtMs: Date.now(),
    // Empty CIK is the "did not resolve" discriminator; a resolved company with
    // a quiet 90-day window returns its real CIK alongside zero signals.
    cik: '',
    unavailable,
  };
}
