import {
  cacheFreshness,
  cleanTitle,
  countryName,
  finite,
  humanizeId,
  joinList,
  record,
  spokenAgo,
  spokenCount,
  spokenInteger,
  spokenMonthYear,
  spokenNumber,
  spokenPercent,
  spokenPoints,
  text,
  toEpochMs,
  toIso,
  type SpokenCitation,
  type SpokenNarrator,
} from './spoken';

// Per-tool narrators for `response_mode: "spoken"` (api/mcp/spoken.ts). Each
// reads the tool's documented payload shape and returns 2-3 sentences plus
// citations. Every number spoken is read from the payload; nothing is
// estimated or generated. Each tool declares its narrator as `_spoken` on
// its registry entry, so the roster is the registry itself.

// ---------------------------------------------------------------------------
// get_country_risk
// ---------------------------------------------------------------------------
const CII_COMPONENT_LABELS: Record<string, string> = {
  ciiContribution: 'domestic unrest',
  geoConvergence: 'armed conflict',
  militaryActivity: 'security and mobility',
  newsActivity: 'the information environment',
};
const TREND_WORDS: Record<string, string> = {
  TREND_DIRECTION_RISING: 'rising',
  TREND_DIRECTION_STABLE: 'stable',
  TREND_DIRECTION_FALLING: 'falling',
};
const ADVISORY_WORDS: Record<string, string> = {
  'do-not-travel': 'do not travel',
  reconsider: 'reconsider travel',
  caution: 'exercise caution',
  normal: 'normal precautions',
};
// A CII reading older than this is spoken as possibly out of date. The index
// rebuilds every few minutes, so six hours is well past any normal gap.
const COUNTRY_RISK_STALE_MS = 6 * 60 * 60_000;

export const spokenCountryRisk: SpokenNarrator = (result, args, now) => {
  const name = countryName(result.countryCode ?? args.country_code, result.countryName);
  const fetchedMs = toEpochMs(result.fetchedAt);
  const cii = record(result.cii);
  const version = text(cii?.methodologyVersion);
  const indexSource = `WorldMonitor Composite Instability Index${version ? ` (${version})` : ''}`;
  if (result.upstreamUnavailable === true) {
    return {
      sentences: [
        `I could not get a risk reading for ${name} right now because a required data source did not respond.`,
        'Please try again in a few minutes.',
      ],
      citations: [{ source: indexSource, asOf: null, stale: true }],
      stale: true,
      asOf: null,
    };
  }
  const stale = fetchedMs === null || now - fetchedMs > COUNTRY_RISK_STALE_MS;
  const asOf = fetchedMs === null ? null : toIso(fetchedMs);
  const advisory = text(result.advisoryLevel);
  const advisoryPhrase = advisory ? (ADVISORY_WORDS[advisory] ?? advisory.replace(/[-_]+/g, ' ')) : '';
  const sanctionsCount = finite(result.sanctionsCount) ?? 0;
  const sanctionsPhrase = result.sanctionsActive === true && sanctionsCount > 0
    ? `${spokenCount(sanctionsCount, 'sanctioned entity', 'sanctioned entities')} are linked to the country`
    : 'no sanctioned entities are listed';
  const advisorySentence = advisoryPhrase
    ? `The travel advisory is ${advisoryPhrase}, and ${sanctionsPhrase}.`
    : `No travel advisory is in effect, and ${sanctionsPhrase}.`;
  const sentences: string[] = [];
  const score = finite(cii?.combinedScore);
  if (cii && score !== null) {
    const trend = TREND_WORDS[text(cii.trend)];
    sentences.push(`${name} scores ${spokenInteger(score)} out of 100 on the instability index${trend ? `, and the trend is ${trend}` : ''}.`);
    const components = record(cii.components);
    const top = components
      ? Object.entries(components)
        .map(([key, value]) => ({ label: CII_COMPONENT_LABELS[key], value: finite(value) }))
        .filter((entry): entry is { label: string; value: number } => entry.label !== undefined && entry.value !== null)
        .sort((a, b) => b.value - a.value)[0]
      : undefined;
    if (top) sentences.push(`The largest contribution comes from ${top.label}, at ${spokenInteger(top.value)}.`);
  } else {
    sentences.push(`${name} is not tracked by the instability index, so no score is available.`);
  }
  sentences.push(advisorySentence);
  const caveat = !stale
    ? undefined
    : fetchedMs === null
      ? 'The time of this reading is unknown, so treat the numbers with care.'
      : `This reading is from ${spokenAgo(fetchedMs, now)} and may be out of date.`;
  return {
    sentences,
    caveat,
    citations: [{ source: indexSource, asOf, stale }],
    stale,
    asOf,
  };
};

// ---------------------------------------------------------------------------
// get_world_brief
// ---------------------------------------------------------------------------
export const spokenWorldBrief: SpokenNarrator = (result, _args, now) => {
  const stale = result.stale === true;
  const generatedMs = toEpochMs(result.generatedAt);
  const ageMinutes = finite(result.ageMinutes);
  const ago = ageMinutes !== null ? spokenAgo(now - ageMinutes * 60_000, now) : generatedMs !== null ? spokenAgo(generatedMs, now) : 'at an unknown time';
  const headlines = (Array.isArray(result.headlines) ? result.headlines : []).map((h) => cleanTitle(h)).filter((h) => h.length > 0);
  const sentences = [
    stale
      ? `The latest world brief was written ${ago} and is older than usual, so treat it as the last known picture.`
      : `The latest world brief was written ${ago}.`,
  ];
  if (headlines.length === 0) sentences.push('It carries no headlines right now.');
  else if (headlines.length === 1) sentences.push(`The top story is ${headlines[0]}.`);
  else sentences.push(`The top story is ${headlines[0]}, followed by ${headlines[1]}.`);
  if (headlines.length >= 3) sentences.push(`Also in the brief: ${headlines[2]}.`);
  const asOf = toIso(result.generatedAt);
  const citations: SpokenCitation[] = (Array.isArray(result.sources) ? result.sources : [])
    .map((source) => record(source))
    .filter((source): source is Record<string, unknown> => source !== null)
    .map((source) => {
      const url = text(source.url);
      return {
        source: text(source.source) || 'World brief source',
        title: cleanTitle(source.title),
        ...(url ? { url } : {}),
        asOf: toIso(source.publishedAt) ?? asOf,
        stale,
      };
    });
  if (citations.length === 0) citations.push({ source: 'WorldMonitor world brief', asOf, stale });
  return { sentences, citations, stale, asOf };
};

// ---------------------------------------------------------------------------
// get_chokepoint_status
// ---------------------------------------------------------------------------
type ChokepointRow = {
  id: string;
  name: string;
  riskLevel: string;
  incidents: number | null;
  todayTotal: number | null;
  countsAvailable: boolean;
  wowChangePct: number | null;
  currentMbd: number | null;
  baselineMbd: number | null;
  flowRatio: number | null;
  disrupted: boolean;
};
const RISK_RANK: Record<string, number> = { critical: 4, high: 3, elevated: 2, moderate: 1, low: 0 };

// `flowsKnown` is false when the snapshot carries no flow map at all (a
// `dataset` filter left it out, or the cache read failed). An absent map must
// not read as "nothing is disrupted"; only an explicit `disrupted: false` may.
function chokepointRows(data: Record<string, unknown>): { rows: ChokepointRow[]; flowsKnown: boolean } {
  const summaries = record(record(data['transit-summaries'])?.summaries) ?? {};
  const flowMap = record(data['chokepoint-flows']);
  const flows = flowMap ?? {};
  const names = new Map<string, string>();
  for (const entry of (Array.isArray(record(data['chokepoint-baselines'])?.chokepoints) ? record(data['chokepoint-baselines'])!.chokepoints as unknown[] : [])) {
    const row = record(entry);
    const name = text(row?.name);
    if (!row || !name) continue;
    for (const key of [row.id, row.relayId]) if (typeof key === 'string' && key) names.set(key, name);
  }
  const ids = [...new Set([...Object.keys(summaries), ...Object.keys(flows)])];
  const rows = ids.map((id) => {
    const summary = record(summaries[id]);
    const flow = record(flows[id]);
    return {
      id,
      name: names.get(id) ?? humanizeId(id),
      riskLevel: text(summary?.riskLevel).toLowerCase(),
      incidents: finite(summary?.incidentCount7d),
      todayTotal: finite(summary?.todayTotal),
      countsAvailable: summary?.todayCountsAvailable !== false && finite(summary?.todayTotal) !== null,
      wowChangePct: finite(summary?.wowChangePct),
      currentMbd: finite(flow?.currentMbd),
      baselineMbd: finite(flow?.baselineMbd),
      flowRatio: finite(flow?.flowRatio),
      disrupted: flow?.disrupted === true,
    };
  });
  return { rows, flowsKnown: flowMap !== null };
}

function flowClause(row: ChokepointRow, subject: string): string | null {
  if (row.currentMbd === null) return null;
  let clause = `${subject} is ${spokenNumber(row.currentMbd)} million barrels a day`;
  if (row.baselineMbd !== null && row.baselineMbd > 0) {
    clause += ` against a normal ${spokenNumber(row.baselineMbd)}`;
    const ratio = row.flowRatio ?? row.currentMbd / row.baselineMbd;
    clause += `, about ${spokenPercent(Math.round(ratio * 100))} of normal`;
  }
  return clause;
}

function incidentsClause(row: ChokepointRow): string {
  return row.incidents !== null ? `, with ${spokenCount(row.incidents, 'incident')} in the past 7 days` : '';
}

export const spokenChokepointStatus: SpokenNarrator = (result, _args, now) => {
  const freshness = cacheFreshness(result, now);
  const citations: SpokenCitation[] = [{ source: 'WorldMonitor chokepoint monitor (AIS relay and IMF PortWatch)', asOf: freshness.asOf, stale: freshness.stale }];
  const data = record(result.data) ?? {};
  const baselines = record(data['chokepoint-baselines']);
  const baselineSource = text(baselines?.source);
  if (baselineSource) citations.push({ source: baselineSource, asOf: toIso(baselines?.updatedAt), stale: freshness.stale });
  const { rows, flowsKnown } = chokepointRows(data);
  if (rows.length === 0) {
    return {
      sentences: ['No chokepoint data is loaded in this snapshot.', 'Try again shortly, or call without a chokepoint filter.'],
      caveat: freshness.caveat, citations, stale: freshness.stale, asOf: freshness.asOf,
    };
  }
  const sentences: string[] = [];
  if (rows.length === 1) {
    const row = rows[0]!;
    sentences.push(row.riskLevel
      ? `${row.name} is at ${row.riskLevel} risk${incidentsClause(row)}.`
      : `${row.name} has no risk rating at the moment${incidentsClause(row)}.`);
    const flow = flowClause(row, 'Oil flow');
    if (flow) sentences.push(`${flow}${row.disrupted ? ', and it is flagged as disrupted' : ''}.`);
    else if (row.disrupted) sentences.push('Oil flow through it is flagged as disrupted.');
    else if (!flowsKnown) sentences.push('Oil flow and disruption status were not included in this snapshot.');
    if (row.countsAvailable && row.todayTotal !== null) {
      const change = row.wowChangePct !== null && Math.round(Math.abs(row.wowChangePct)) > 0
        ? `, ${row.wowChangePct > 0 ? 'up' : 'down'} ${spokenPercent(Math.abs(row.wowChangePct))} on last week`
        : '';
      sentences.push(`${spokenCount(row.todayTotal, 'vessel')} transited today${change}.`);
    } else {
      sentences.push("Today's transit count is not available yet.");
    }
  } else {
    const disrupted = rows.filter((row) => row.disrupted);
    sentences.push(!flowsKnown
      ? `${spokenCount(rows.length, 'monitored chokepoint')} are in this snapshot, but disruption status was not included.`
      : disrupted.length === 0
        ? `None of the ${spokenInteger(rows.length)} monitored chokepoints is flagged as disrupted.`
        : `Of ${spokenInteger(rows.length)} monitored chokepoints, ${disrupted.length === 1 ? '1 is' : `${spokenInteger(disrupted.length)} are`} flagged as disrupted: ${joinList(disrupted.map((row) => row.name))}.`);
    const riskiest = [...rows].filter((row) => row.riskLevel).sort((a, b) => (RISK_RANK[b.riskLevel] ?? -1) - (RISK_RANK[a.riskLevel] ?? -1) || (b.incidents ?? 0) - (a.incidents ?? 0))[0];
    sentences.push(riskiest
      ? `The highest risk level is ${riskiest.riskLevel}, at ${riskiest.name}${incidentsClause(riskiest)}.`
      : 'No chokepoint carries a risk rating at the moment.');
    const focus = disrupted[0] ?? riskiest;
    const flow = focus ? flowClause(focus, `Oil flow through ${focus.name}`) : null;
    if (flow) sentences.push(`${flow}.`);
  }
  return { sentences, caveat: freshness.caveat, citations, stale: freshness.stale, asOf: freshness.asOf };
};

// ---------------------------------------------------------------------------
// get_prediction_markets
// ---------------------------------------------------------------------------
const MARKET_BUCKETS = ['geopolitical', 'tech', 'finance'] as const;
const VENUE_NAMES: Record<string, string> = { polymarket: 'Polymarket', kalshi: 'Kalshi' };

// `appositive` closes a "The leading X market, TITLE, is priced" aside with
// its second comma; the "Next, TITLE is priced" form takes none.
function marketClause(market: Record<string, unknown>, appositive = false): string {
  const price = finite(market.yesPrice);
  const change = finite(market.change24h);
  let clause = `${cleanTitle(market.title)}${appositive ? ',' : ''} is priced at ${price === null ? 'an unknown level' : spokenPercent(price)}`;
  if (change !== null && Math.round(Math.abs(change)) > 0) clause += `, ${spokenPoints(change)} in the past day`;
  return clause;
}

function marketCitation(market: Record<string, unknown>, asOf: string | null, stale: boolean): SpokenCitation {
  const url = text(market.url);
  const venue = text(market.source).toLowerCase();
  return { source: VENUE_NAMES[venue] ?? (venue ? humanizeId(venue) : 'Prediction market'), title: cleanTitle(market.title), ...(url ? { url } : {}), asOf, stale };
}

export const spokenPredictionMarkets: SpokenNarrator = (result, _args, now) => {
  const freshness = cacheFreshness(result, now);
  const bootstrap = record(record(result.data)?.['markets-bootstrap']) ?? {};
  const buckets = MARKET_BUCKETS.map((bucket) => ({
    bucket,
    markets: (Array.isArray(bootstrap[bucket]) ? bootstrap[bucket] as unknown[] : []).map(record).filter((m): m is Record<string, unknown> => m !== null),
  }));
  const total = buckets.reduce((sum, entry) => sum + entry.markets.length, 0);
  const fallback: SpokenCitation = { source: 'WorldMonitor prediction markets', asOf: freshness.asOf, stale: freshness.stale };
  if (total === 0) {
    return {
      sentences: [`No prediction markets match those filters${freshness.asOf === null ? '' : ` as of ${freshness.ago}`}.`, 'Try a broader query or another category.'],
      caveat: freshness.caveat, citations: [fallback], stale: freshness.stale, asOf: freshness.asOf,
    };
  }
  const counts = buckets.map(({ bucket, markets }) => markets.length === 0 ? `none in ${bucket}` : `${spokenInteger(markets.length)} ${bucket}`);
  // With no `cached_at` the stale caveat already says the time is unknown.
  const sentences = [`Prediction markets${freshness.asOf === null ? '' : ` as of ${freshness.ago}`} track ${spokenCount(total, 'contract')}: ${joinList(counts)}.`];
  const spokenMarkets: Record<string, unknown>[] = [];
  const populated = buckets.filter((entry) => entry.markets.length > 0);
  const lead = populated[0]!;
  spokenMarkets.push(lead.markets[0]!);
  sentences.push(`The leading ${lead.bucket} market, ${marketClause(lead.markets[0]!, true)}.`);
  if (populated.length > 1) {
    const next = populated[1]!;
    spokenMarkets.push(next.markets[0]!);
    sentences.push(`The leading ${next.bucket} market, ${marketClause(next.markets[0]!, true)}.`);
  } else if (lead.markets.length > 1) {
    spokenMarkets.push(lead.markets[1]!);
    sentences.push(`Next, ${marketClause(lead.markets[1]!)}.`);
  }
  return {
    sentences,
    caveat: freshness.caveat,
    citations: spokenMarkets.map((market) => marketCitation(market, freshness.asOf, freshness.stale)),
    stale: freshness.stale,
    asOf: freshness.asOf,
  };
};

// ---------------------------------------------------------------------------
// get_forecast_predictions
// ---------------------------------------------------------------------------
function forecastClause(row: Record<string, unknown>): string {
  const probability = finite(row.probability);
  const domain = text(row.domain).replace(/[_-]+/g, ' ');
  const region = cleanTitle(row.region);
  let clause = `${probability === null ? 'an unknown probability' : spokenPercent(Math.round(probability * 100))} for ${cleanTitle(row.title)}`;
  if (domain || region) clause += `, a${domain ? ` ${domain}` : ''} forecast${region ? ` for ${region}` : ''}`;
  const change = finite(row.change24h);
  if (change !== null && Math.round(Math.abs(change) * 100) > 0) clause += `, ${spokenPoints(change * 100)} in the past day`;
  return clause;
}

export const spokenForecastPredictions: SpokenNarrator = (result, _args, now) => {
  const freshness = cacheFreshness(result, now);
  const node = record(record(result.data)?.predictions);
  const generatedMs = toEpochMs(node?.generatedAt) ?? toEpochMs(result.cached_at);
  const asOf = generatedMs === null ? freshness.asOf : toIso(generatedMs);
  const rows = (Array.isArray(node?.predictions) ? node.predictions as unknown[] : [])
    .map(record)
    .filter((row): row is Record<string, unknown> => row !== null)
    .sort((a, b) => (finite(b.probability) ?? -1) - (finite(a.probability) ?? -1));
  const source = 'WorldMonitor forecasts';
  if (rows.length === 0) {
    return {
      sentences: ['No published forecasts match those filters right now.', 'Try another domain or region, or call again without filters.'],
      caveat: freshness.caveat, citations: [{ source, asOf, stale: freshness.stale }], stale: freshness.stale, asOf,
    };
  }
  const ago = generatedMs === null ? freshness.ago : spokenAgo(generatedMs, now);
  const sentences = [
    `WorldMonitor currently publishes ${spokenCount(rows.length, 'forecast')}, generated ${ago}; these are AI assessments, not guarantees.`,
    `The highest probability is ${forecastClause(rows[0]!)}.`,
  ];
  if (rows.length > 1) sentences.push(`Next is ${forecastClause(rows[1]!)}.`);
  return {
    sentences,
    caveat: freshness.caveat,
    citations: rows.slice(0, 3).map((row) => ({ source, title: cleanTitle(row.title), asOf, stale: freshness.stale })),
    stale: freshness.stale,
    asOf,
  };
};

// ---------------------------------------------------------------------------
// get_media_perspective
// ---------------------------------------------------------------------------
export const spokenMediaPerspective: SpokenNarrator = (result, args, _now) => {
  const subject = text(result.subjectCountry) || text(args.subject_country).toUpperCase();
  const name = countryName(subject);
  const asOf = toIso(result.readAt);
  const state = text(result.state);
  const windowHours = finite(result.windowHours);
  const windowPhrase = windowHours === null ? 'the look-back window' : `the past ${spokenInteger(windowHours)} hours`;
  const fallback: SpokenCitation = { source: 'WorldMonitor media perspective', asOf, stale: state !== 'complete' };
  if (state === 'unavailable') {
    return {
      sentences: [`Media coverage for ${name} is unavailable right now.`, 'Please try again later.'],
      citations: [fallback], stale: true, asOf,
    };
  }
  const groups = (Array.isArray(result.groups) ? result.groups : []).map(record).filter((g): g is Record<string, unknown> => g !== null);
  const headlineCount = (group: Record<string, unknown>) => finite(group.headlineCount) ?? (Array.isArray(group.headlines) ? group.headlines.length : 0);
  const total = groups.reduce((sum, group) => sum + headlineCount(group), 0);
  const outlets = groups.reduce((sum, group) => sum + (finite(group.outletCount) ?? 0), 0);
  const partial = state === 'partial';
  const caveat = partial ? 'Some feeds were unavailable, so this is a partial view.' : undefined;
  if (total === 0) {
    return {
      sentences: [`No headlines mentioning ${name} were found in ${windowPhrase}.`, 'Try a longer window or different outlet filters.'],
      caveat, citations: [fallback], stale: partial, asOf,
    };
  }
  let own = 0; let foreignFacing = 0; let outside = 0;
  const framing = { favorable: 0, neutral: 0, critical: 0, hostile: 0 };
  const headlines: Array<{ outlet: string; title: string; url: string; publishedAt: number | null }> = [];
  for (const group of groups) {
    const count = headlineCount(group);
    if (text(group.homeCountry).toUpperCase() !== subject.toUpperCase()) outside += count;
    else if (text(group.audience) === 'domestic') own += count;
    else foreignFacing += count;
    const labels = record(group.framing);
    for (const key of Object.keys(framing) as Array<keyof typeof framing>) framing[key] += finite(labels?.[key]) ?? 0;
    for (const item of (Array.isArray(group.headlines) ? group.headlines : [])) {
      const headline = record(item);
      if (!headline) continue;
      const title = cleanTitle(text(headline.englishTitle) || headline.title);
      if (!title) continue;
      headlines.push({ outlet: text(headline.outlet) || 'an outlet', title, url: text(headline.link), publishedAt: toEpochMs(headline.publishedAt) });
    }
  }
  const countPhrase = (count: number) => (count === 0 ? 'none' : spokenInteger(count));
  const sentences = [
    `Over ${windowPhrase}, ${spokenCount(total, 'headline')} from ${spokenCount(outlets, 'outlet')} covered ${name}: ${countPhrase(own)} from its own press, ${countPhrase(foreignFacing)} from its foreign-facing media and ${countPhrase(outside)} from outside coverage.`,
  ];
  const labelled = framing.favorable + framing.neutral + framing.critical + framing.hostile;
  // Stance is a model's reading of each headline, not WorldMonitor's view;
  // the sentence says so, as the tool description does.
  sentences.push(labelled === 0
    ? 'No model stance labels are available for these headlines yet.'
    : `Of the ${spokenCount(labelled, 'headline')} a model labelled for stance, ${spokenInteger(framing.favorable)} read as favorable, ${spokenInteger(framing.neutral)} neutral and ${spokenInteger(framing.critical + framing.hostile)} critical or hostile.`);
  headlines.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  const latest = headlines[0];
  if (latest) sentences.push(`The most recent is from ${latest.outlet}: ${latest.title}.`);
  const citations: SpokenCitation[] = headlines.slice(0, 6).map((headline) => ({
    source: headline.outlet, title: headline.title, ...(headline.url ? { url: headline.url } : {}),
    asOf: headline.publishedAt === null ? asOf : toIso(headline.publishedAt), stale: partial,
  }));
  return { sentences, caveat, citations: citations.length > 0 ? citations : [fallback], stale: partial, asOf };
};

// ---------------------------------------------------------------------------
// get_resilience_indicators
// ---------------------------------------------------------------------------
const DIMENSION_LABELS: Record<string, string> = {
  macroFiscal: 'public finances',
  currencyExternal: 'currency and external balance',
  tradePolicy: 'trade policy',
  financialSystemExposure: 'financial system exposure',
  cyberDigital: 'cyber and digital',
  logisticsSupply: 'logistics and supply',
  infrastructure: 'infrastructure',
  energy: 'energy',
  governanceInstitutional: 'governance',
  socialCohesion: 'social cohesion',
  borderSecurity: 'border security',
  informationCognitive: 'information environment',
};

export const spokenResilienceIndicators: SpokenNarrator = (result, args, _now) => {
  const code = text(result.countryCode) || text(args.country_code).toUpperCase();
  const name = countryName(code);
  const dataVersion = text(result.dataVersion);
  const asOf = toIso(dataVersion);
  const citations: SpokenCitation[] = [{ source: 'WorldMonitor resilience score', asOf, stale: false }];
  const dimensions = (Array.isArray(result.dimensions) ? result.dimensions : [])
    .map(record)
    .filter((d): d is Record<string, unknown> => d !== null && d.active !== false && d.reconciliationAvailable !== false && finite(d.score) !== null)
    .map((d) => ({ label: DIMENSION_LABELS[text(d.id)] ?? humanizeId(text(d.id)).toLowerCase(), score: finite(d.score)! }))
    .sort((a, b) => b.score - a.score);
  if (dimensions.length === 0) {
    return { sentences: [`No resilience breakdown is available for ${name} right now.`, 'Please try again later.'], citations, stale: true, asOf };
  }
  const month = spokenMonthYear(dataVersion);
  const sentences = [`${name}'s resilience breakdown covers ${spokenCount(dimensions.length, 'dimension')}, using ${month ? `data from ${month}` : 'the current data snapshot'}.`];
  const at = (d: { label: string; score: number }) => `${d.label} at ${spokenInteger(d.score)}`;
  if (dimensions.length === 1) sentences.push(`Its only scored dimension is ${at(dimensions[0]!)}.`);
  else if (dimensions.length < 4) sentences.push(`Its strongest area is ${at(dimensions[0]!)}, and its weakest is ${at(dimensions[dimensions.length - 1]!)}.`);
  else {
    const weakest = dimensions.slice(-2).reverse();
    sentences.push(`Its strongest areas are ${at(dimensions[0]!)} and ${at(dimensions[1]!)}, and its weakest are ${at(weakest[0]!)} and ${at(weakest[1]!)}.`);
  }
  const indicators = (Array.isArray(result.indicators) ? result.indicators : []).map(record).filter((i): i is Record<string, unknown> => i !== null);
  // Retired, inactive and not-applicable rows are deliberate exclusions, not
  // data gaps, so they leave the count; failed sources are named as such.
  const active = indicators.filter((indicator) => !['inactive', 'retired', 'not-applicable'].includes(text(indicator.state)));
  const stateCount = (state: string) => active.filter((indicator) => text(indicator.state) === state).length;
  const observed = stateCount('observed');
  if (active.length > 0) {
    const gaps: string[] = [];
    const imputed = stateCount('imputed') + stateCount('fallback');
    const failed = stateCount('source-failure');
    const missing = active.length - observed - imputed - failed;
    if (imputed > 0) gaps.push(`${spokenInteger(imputed)} imputed`);
    if (failed > 0) gaps.push(`${spokenInteger(failed)} from a failed source`);
    if (missing > 0) gaps.push(`${spokenInteger(missing)} missing`);
    sentences.push(observed === active.length
      ? `All ${spokenCount(active.length, 'active indicator')} are directly observed.`
      : `${spokenInteger(observed)} of ${spokenCount(active.length, 'active indicator')} are directly observed, with ${joinList(gaps)}.`);
  }
  const seen = new Set<string>();
  for (const indicator of indicators) {
    for (const entry of (Array.isArray(indicator.sources) ? indicator.sources : [])) {
      const source = record(entry);
      const sourceName = text(source?.name);
      if (!source || !sourceName || seen.has(sourceName) || citations.length >= 9) continue;
      seen.add(sourceName);
      const url = text(source.url);
      citations.push({ source: sourceName, ...(url ? { url } : {}), asOf: toIso(indicator.retrievedAt), stale: false });
    }
  }
  return { sentences, citations, stale: false, asOf };
};
