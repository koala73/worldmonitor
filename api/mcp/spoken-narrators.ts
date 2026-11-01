import {
  arabicHours,
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
  staleFreshnessKeys,
  text,
  toEpochMs,
  toIso,
  unknownTime,
  type SpokenCitation,
  type SpokenLanguage,
  type SpokenNarrator,
} from './spoken';
import { resolveCountryArg } from './_country-args';

// Per-tool narrators for `response_mode: "spoken"` (api/mcp/spoken.ts). Each
// reads the tool's documented payload shape and returns 2-3 sentences plus
// citations. Every number spoken is read from the payload; nothing is
// estimated or generated. Each tool declares its narrator as `_spoken` on
// its registry entry, so the roster is the registry itself.
//
// Each narrator has ONE data path and takes its wording from a per-language
// phrase set (`spoken_language`, #9722), so the English and Arabic answers
// speak the same numbers, caveats and freshness verdicts. The Arabic phrases
// are Modern Standard Arabic and avoid number-noun agreement where they can
// ("عدد X N" rather than a counted noun), because a template cannot inflect a
// noun for every count; where a count must be spoken with its noun,
// `arabicCount` picks the form by CLDR plural category.

// ---------------------------------------------------------------------------
// Shared Arabic names
// ---------------------------------------------------------------------------

/**
 * Arabic names for every chokepoint in server/_shared/chokepoint-registry.ts,
 * keyed by its id (the relay id the transit summaries and flows are keyed by)
 * and by the EIA baseline id where it differs. A test keeps this complete.
 */
export const CHOKEPOINT_NAMES_AR: Readonly<Record<string, string>> = {
  suez: 'قناة السويس',
  malacca_strait: 'مضيق ملقا',
  malacca: 'مضيق ملقا',
  hormuz_strait: 'مضيق هرمز',
  hormuz: 'مضيق هرمز',
  bab_el_mandeb: 'مضيق باب المندب',
  babelm: 'مضيق باب المندب',
  panama: 'قناة بنما',
  taiwan_strait: 'مضيق تايوان',
  cape_of_good_hope: 'رأس الرجاء الصالح',
  gibraltar: 'مضيق جبل طارق',
  bosphorus: 'مضيق البوسفور',
  korea_strait: 'مضيق كوريا',
  dover_strait: 'مضيق دوفر',
  kerch_strait: 'مضيق كيرتش',
  lombok_strait: 'مضيق لومبوك',
};

// ---------------------------------------------------------------------------
// get_country_risk
// ---------------------------------------------------------------------------
const CII_COMPONENT_LABELS: Record<SpokenLanguage, Record<string, string>> = {
  en: {
    ciiContribution: 'domestic unrest',
    geoConvergence: 'armed conflict',
    militaryActivity: 'security and mobility',
    newsActivity: 'the information environment',
  },
  ar: {
    ciiContribution: 'الاضطرابات الداخلية',
    geoConvergence: 'النزاع المسلح',
    militaryActivity: 'الأمن والتنقل',
    newsActivity: 'البيئة الإعلامية',
  },
};
const TREND_WORDS: Record<SpokenLanguage, Record<string, string>> = {
  en: {
    TREND_DIRECTION_RISING: 'rising',
    TREND_DIRECTION_STABLE: 'stable',
    TREND_DIRECTION_FALLING: 'falling',
  },
  ar: {
    TREND_DIRECTION_RISING: 'تصاعدي',
    TREND_DIRECTION_STABLE: 'مستقر',
    TREND_DIRECTION_FALLING: 'تنازلي',
  },
};
const ADVISORY_WORDS: Record<SpokenLanguage, Record<string, string>> = {
  en: {
    'do-not-travel': 'do not travel',
    reconsider: 'reconsider travel',
    caution: 'exercise caution',
    normal: 'normal precautions',
  },
  ar: {
    'do-not-travel': 'عدم السفر',
    reconsider: 'إعادة النظر في السفر',
    caution: 'توخي الحذر',
    normal: 'اتخاذ الاحتياطات المعتادة',
  },
};
// A CII reading older than this is spoken as possibly out of date. The index
// rebuilds every few minutes, so six hours is well past any normal gap.
const COUNTRY_RISK_STALE_MS = 6 * 60 * 60_000;

const COUNTRY_RISK_PHRASES = {
  en: {
    unavailable: (name: string) => [
      `I could not get a risk reading for ${name} right now because a required data source did not respond.`,
      'Please try again in a few minutes.',
    ],
    sanctions: (count: number) => `${spokenCount(count, 'sanctioned entity', 'sanctioned entities')} are linked to the country`,
    noSanctions: 'no sanctioned entities are listed',
    advisory: (advisory: string, sanctions: string) => `The travel advisory is ${advisory}, and ${sanctions}.`,
    noAdvisory: (sanctions: string) => `No travel advisory is in effect, and ${sanctions}.`,
    score: (name: string, score: number, trend: string | undefined) =>
      `${name} scores ${spokenInteger(score)} out of 100 on the instability index${trend ? `, and the trend is ${trend}` : ''}.`,
    topComponent: (label: string, value: number) => `The largest contribution comes from ${label}, at ${spokenInteger(value)}.`,
    untracked: (name: string) => `${name} is not tracked by the instability index, so no score is available.`,
    unknownTime: 'The time of this reading is unknown, so treat the numbers with care.',
    old: (ago: string) => `This reading is from ${ago} and may be out of date.`,
  },
  ar: {
    unavailable: (name: string) => [
      `تعذّر الحصول على قراءة للمخاطر عن ${name} الآن، لأن أحد مصادر البيانات المطلوبة لم يستجب.`,
      'يُرجى المحاولة مرة أخرى بعد بضع دقائق.',
    ],
    sanctions: (count: number) => `عدد الكيانات الخاضعة للعقوبات والمرتبطة بالبلد ${spokenInteger(count)}`,
    noSanctions: 'لا توجد كيانات مدرجة على قوائم العقوبات',
    advisory: (advisory: string, sanctions: string) => `تحذير السفر الحالي يدعو إلى ${advisory}، و${sanctions}.`,
    noAdvisory: (sanctions: string) => `لا يوجد تحذير سفر ساري المفعول، و${sanctions}.`,
    score: (name: string, score: number, trend: string | undefined) =>
      `درجة ${name} على مؤشر عدم الاستقرار ${spokenInteger(score)} من 100${trend ? `، والاتجاه ${trend}` : ''}.`,
    topComponent: (label: string, value: number) => `أكبر مساهمة تأتي من ${label}، بدرجة ${spokenInteger(value)}.`,
    untracked: (name: string) => `لا يشمل مؤشر عدم الاستقرار ${name}، لذا لا تتوفر أي درجة.`,
    unknownTime: 'وقت هذه القراءة غير معروف، لذا تعامل مع الأرقام بحذر.',
    old: (ago: string) => `صدرت هذه القراءة ${ago}، وقد لا تكون محدّثة.`,
  },
} as const;

export const spokenCountryRisk: SpokenNarrator = (result, args, now, lang = 'en') => {
  const say = COUNTRY_RISK_PHRASES[lang];
  const name = countryName(result.countryCode ?? args.country_code, result.countryName, lang);
  const fetchedMs = toEpochMs(result.fetchedAt);
  const cii = record(result.cii);
  const version = text(cii?.methodologyVersion);
  const indexSource = `WorldMonitor Composite Instability Index${version ? ` (${version})` : ''}`;
  if (result.upstreamUnavailable === true) {
    return {
      sentences: [...say.unavailable(name)],
      citations: [{ source: indexSource, asOf: null, stale: true }],
      stale: true,
      asOf: null,
    };
  }
  const stale = fetchedMs === null || now - fetchedMs > COUNTRY_RISK_STALE_MS;
  const asOf = fetchedMs === null ? null : toIso(fetchedMs);
  const advisory = text(result.advisoryLevel);
  const advisoryPhrase = advisory ? (ADVISORY_WORDS[lang][advisory] ?? advisory.replace(/[-_]+/g, ' ')) : '';
  const sanctionsCount = finite(result.sanctionsCount) ?? 0;
  const sanctionsPhrase = result.sanctionsActive === true && sanctionsCount > 0
    ? say.sanctions(sanctionsCount)
    : say.noSanctions;
  const advisorySentence = advisoryPhrase
    ? say.advisory(advisoryPhrase, sanctionsPhrase)
    : say.noAdvisory(sanctionsPhrase);
  const sentences: string[] = [];
  const score = finite(cii?.combinedScore);
  if (cii && score !== null) {
    sentences.push(say.score(name, score, TREND_WORDS[lang][text(cii.trend)]));
    const components = record(cii.components);
    const top = components
      ? Object.entries(components)
        .map(([key, value]) => ({ label: CII_COMPONENT_LABELS[lang][key], value: finite(value) }))
        .filter((entry): entry is { label: string; value: number } => entry.label !== undefined && entry.value !== null)
        .sort((a, b) => b.value - a.value)[0]
      : undefined;
    if (top) sentences.push(say.topComponent(top.label, top.value));
  } else {
    sentences.push(say.untracked(name));
  }
  sentences.push(advisorySentence);
  const caveat = !stale
    ? undefined
    : fetchedMs === null
      ? say.unknownTime
      : say.old(spokenAgo(fetchedMs, now, lang));
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
const WORLD_BRIEF_PHRASES = {
  en: {
    stale: (ago: string) => `The latest world brief was written ${ago} and is older than usual, so treat it as the last known picture.`,
    fresh: (ago: string) => `The latest world brief was written ${ago}.`,
    none: 'It carries no headlines right now.',
    one: (a: string) => `The top story is ${a}.`,
    two: (a: string, b: string) => `The top story is ${a}, followed by ${b}.`,
    also: (c: string) => `Also in the brief: ${c}.`,
  },
  ar: {
    stale: (ago: string) => `كُتب أحدث موجز عالمي ${ago}، وهو أقدم من المعتاد، لذا اعتبره آخر صورة معروفة.`,
    fresh: (ago: string) => `كُتب أحدث موجز عالمي ${ago}.`,
    none: 'لا يتضمن الموجز أي عناوين حاليًا.',
    one: (a: string) => `أبرز خبر: ${a}.`,
    two: (a: string, b: string) => `أبرز خبر: ${a}، يليه: ${b}.`,
    also: (c: string) => `ومن أخبار الموجز أيضًا: ${c}.`,
  },
} as const;

export const spokenWorldBrief: SpokenNarrator = (result, _args, now, lang = 'en') => {
  const say = WORLD_BRIEF_PHRASES[lang];
  const stale = result.stale === true;
  const generatedMs = toEpochMs(result.generatedAt);
  const ageMinutes = finite(result.ageMinutes);
  const ago = ageMinutes !== null
    ? spokenAgo(now - ageMinutes * 60_000, now, lang)
    : generatedMs !== null ? spokenAgo(generatedMs, now, lang) : unknownTime(lang);
  const headlines = (Array.isArray(result.headlines) ? result.headlines : []).map((h) => cleanTitle(h)).filter((h) => h.length > 0);
  const sentences = [stale ? say.stale(ago) : say.fresh(ago)];
  if (headlines.length === 0) sentences.push(say.none);
  else if (headlines.length === 1) sentences.push(say.one(headlines[0]!));
  else sentences.push(say.two(headlines[0]!, headlines[1]!));
  if (headlines.length >= 3) sentences.push(say.also(headlines[2]!));
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
const RISK_WORDS_AR: Record<string, string> = {
  critical: 'حرج',
  high: 'مرتفع',
  elevated: 'مرتفع نسبيًا',
  moderate: 'متوسط',
  low: 'منخفض',
};

// `flowsKnown` is false when the snapshot carries no flow map at all (a
// `dataset` filter left it out, or the cache read failed). An absent map must
// not read as "nothing is disrupted"; only an explicit `disrupted: false` may.
function chokepointRows(data: Record<string, unknown>, lang: SpokenLanguage): { rows: ChokepointRow[]; flowsKnown: boolean } {
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
      name: (lang === 'ar' ? CHOKEPOINT_NAMES_AR[id] : undefined) ?? names.get(id) ?? humanizeId(id),
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

const CHOKEPOINT_PHRASES = {
  en: {
    risk: (level: string) => level,
    flowSubject: 'Oil flow',
    flowThrough: (name: string) => `Oil flow through ${name}`,
    flow: (subject: string, current: number) => `${subject} is ${spokenNumber(current)} million barrels a day`,
    flowBaseline: (baseline: number) => ` against a normal ${spokenNumber(baseline)}`,
    flowRatio: (percent: number) => `, about ${spokenPercent(percent)} of normal`,
    incidents: (count: number) => `, with ${spokenCount(count, 'incident')} in the past 7 days`,
    transitsPhrase: (ago: string | null) => (ago === null ? 'vessel counts and risk ratings' : `vessel counts and risk ratings, last updated ${ago},`),
    bothStale: (transits: string) => `The ${transits} and the oil flow figures are flagged as stale, so they may be out of date.`,
    transitStaleUnknown: 'The vessel counts and risk ratings are flagged as stale, so they may be out of date.',
    transitStale: (ago: string) => `The vessel counts and risk ratings were last updated ${ago} and are flagged as stale, so they may be out of date.`,
    flowsStale: 'The oil flow figures are flagged as stale, so they may be out of date.',
    someStaleFlow: 'Some supporting data in this snapshot is flagged as stale, so the oil flow figure may be out of date.',
    someStale: 'Some data in this snapshot is flagged as stale.',
    empty: ['No chokepoint data is loaded in this snapshot.', 'Try again shortly, or call without a chokepoint filter.'],
    singleRisk: (name: string, risk: string, incidents: string) => `${name} is at ${risk} risk${incidents}.`,
    singleNoRisk: (name: string, incidents: string) => `${name} has no risk rating at the moment${incidents}.`,
    flowSentence: (flow: string, disrupted: boolean) => `${flow}${disrupted ? ', and it is flagged as disrupted' : ''}.`,
    disruptedOnly: (_name: string) => 'Oil flow through it is flagged as disrupted.',
    flowUnknown: 'Oil flow and disruption status were not included in this snapshot.',
    change: (pct: number) => `, ${pct > 0 ? 'up' : 'down'} ${spokenPercent(Math.abs(pct))} on last week`,
    transits: (count: number, change: string) => `${spokenCount(count, 'vessel')} transited today${change}.`,
    noTransits: "Today's transit count is not available yet.",
    overviewNoFlows: (count: number) => `${spokenCount(count, 'monitored chokepoint')} are in this snapshot, but disruption status was not included.`,
    noneDisrupted: (count: number) => `None of the ${spokenInteger(count)} monitored chokepoints is flagged as disrupted.`,
    someDisrupted: (count: number, disrupted: number, names: string[]) =>
      `Of ${spokenInteger(count)} monitored chokepoints, ${disrupted === 1 ? '1 is' : `${spokenInteger(disrupted)} are`} flagged as disrupted: ${joinList(names)}.`,
    highest: (risk: string, name: string, incidents: string) => `The highest risk level is ${risk}, at ${name}${incidents}.`,
    noneRated: 'No chokepoint carries a risk rating at the moment.',
  },
  ar: {
    risk: (level: string) => RISK_WORDS_AR[level] ?? level,
    flowSubject: 'تدفق النفط',
    flowThrough: (name: string) => `تدفق النفط عبر ${name}`,
    flow: (subject: string, current: number) => `${subject} ${spokenNumber(current)} مليون برميل يوميًا`,
    flowBaseline: (baseline: number) => ` مقابل ${spokenNumber(baseline)} في الوضع الطبيعي`,
    flowRatio: (percent: number) => `، أي نحو ${spokenPercent(percent, 'ar')} من المعتاد`,
    incidents: (count: number) => `، وعدد الحوادث خلال الأيام السبعة الماضية ${spokenInteger(count)}`,
    transitsPhrase: (ago: string | null) => (ago === null ? 'أعداد السفن وتصنيفات المخاطر' : `أعداد السفن وتصنيفات المخاطر، التي حُدّثت آخر مرة ${ago}،`),
    bothStale: (transits: string) => `${transits} وأرقام تدفق النفط مصنفة على أنها قديمة، وقد لا تكون محدّثة.`,
    transitStaleUnknown: 'أعداد السفن وتصنيفات المخاطر مصنفة على أنها قديمة، وقد لا تكون محدّثة.',
    transitStale: (ago: string) => `حُدّثت أعداد السفن وتصنيفات المخاطر آخر مرة ${ago}، وهي مصنفة على أنها قديمة، وقد لا تكون محدّثة.`,
    flowsStale: 'أرقام تدفق النفط مصنفة على أنها قديمة، وقد لا تكون محدّثة.',
    someStaleFlow: 'بعض البيانات الداعمة في هذه اللقطة مصنفة على أنها قديمة، لذا قد لا يكون رقم تدفق النفط محدّثًا.',
    someStale: 'بعض البيانات في هذه اللقطة مصنفة على أنها قديمة.',
    empty: ['لا توجد بيانات عن الممرات البحرية في هذه اللقطة.', 'حاول مرة أخرى بعد قليل، أو أعد الطلب دون تحديد ممر.'],
    singleRisk: (name: string, risk: string, incidents: string) => `مستوى المخاطر في ${name} ${risk}${incidents}.`,
    singleNoRisk: (name: string, incidents: string) => `لا يوجد تصنيف للمخاطر في ${name} حاليًا${incidents}.`,
    flowSentence: (flow: string, disrupted: boolean) => `${flow}${disrupted ? '، وهو مصنف على أنه متعطل' : ''}.`,
    disruptedOnly: (name: string) => `تدفق النفط عبر ${name} مصنف على أنه متعطل.`,
    flowUnknown: 'لم تتضمن هذه اللقطة بيانات تدفق النفط وحالة التعطل.',
    change: (pct: number) => `، ${pct > 0 ? 'بارتفاع' : 'بانخفاض'} ${spokenPercent(Math.abs(pct), 'ar')} عن الأسبوع الماضي`,
    transits: (count: number, change: string) => `عدد السفن التي عبرت اليوم ${spokenInteger(count)}${change}.`,
    noTransits: 'عدد السفن العابرة اليوم غير متاح بعد.',
    overviewNoFlows: (count: number) => `عدد الممرات البحرية المراقبة في هذه اللقطة ${spokenInteger(count)}، لكنها لا تتضمن حالة التعطل.`,
    noneDisrupted: (count: number) => `لا يوجد بين الممرات البحرية المراقبة، وعددها ${spokenInteger(count)}، أي ممر مصنف على أنه متعطل.`,
    someDisrupted: (count: number, disrupted: number, names: string[]) =>
      `عدد الممرات المراقبة المصنفة على أنها متعطلة ${spokenInteger(disrupted)} من أصل ${spokenInteger(count)}: ${joinList(names, 'ar')}.`,
    highest: (risk: string, name: string, incidents: string) => `أعلى مستوى للمخاطر ${risk}، في ${name}${incidents}.`,
    noneRated: 'لا يحمل أي ممر بحري تصنيفًا للمخاطر حاليًا.',
  },
} as const;

function flowClause(row: ChokepointRow, subject: string, lang: SpokenLanguage): string | null {
  const say = CHOKEPOINT_PHRASES[lang];
  if (row.currentMbd === null) return null;
  let clause = say.flow(subject, row.currentMbd);
  if (row.baselineMbd !== null && row.baselineMbd > 0) {
    clause += say.flowBaseline(row.baselineMbd);
    const ratio = row.flowRatio ?? row.currentMbd / row.baselineMbd;
    clause += say.flowRatio(Math.round(ratio * 100));
  }
  return clause;
}

function incidentsClause(row: ChokepointRow, lang: SpokenLanguage): string {
  return row.incidents !== null ? CHOKEPOINT_PHRASES[lang].incidents(row.incidents) : '';
}

// Freshness of the NARRATED data only (#9722). The bundle's `cached_at` is
// its oldest key, which is the annual EIA baselines table on a 400-day
// budget, and its `stale` can be tripped by the port-activity index; neither
// is read aloud. The sentences speak transit summaries (risk, incidents,
// today's count) and oil flows, so those two checks decide the caveat. The
// keys and the 30-minute transit budget mirror this tool's _freshnessChecks.
const TRANSIT_SUMMARIES_CHECK = 'seed-meta:supply_chain:transit-summaries';
const CHOKEPOINT_FLOWS_CHECK = 'seed-meta:energy:chokepoint-flows';
const CHOKEPOINT_BASELINES_CHECK = 'seed-meta:energy:chokepoint-baselines';
const TRANSIT_STALE_MS = 30 * 60_000;

function chokepointCaveat(transitStale: boolean, transitMs: number | null, flowsStale: boolean, now: number, lang: SpokenLanguage): string | undefined {
  const say = CHOKEPOINT_PHRASES[lang];
  const ago = transitMs === null ? null : spokenAgo(transitMs, now, lang);
  if (transitStale && flowsStale) return say.bothStale(say.transitsPhrase(ago));
  if (transitStale) return ago === null ? say.transitStaleUnknown : say.transitStale(ago);
  if (flowsStale) return say.flowsStale;
  return undefined;
}

export const spokenChokepointStatus: SpokenNarrator = (result, _args, now, lang = 'en') => {
  const say = CHOKEPOINT_PHRASES[lang];
  const data = record(result.data) ?? {};
  const summariesNode = record(data['transit-summaries']);
  const transitMs = toEpochMs(summariesNode?.fetchedAt);
  const asOf = transitMs === null ? null : toIso(transitMs);
  const failed = staleFreshnessKeys(result);
  const { rows, flowsKnown } = chokepointRows(data, lang);
  const single = rows.length === 1 ? rows[0]! : null;
  const narratesFlow = flowsKnown && rows.length > 0 && (single === null || single.currentMbd !== null || single.disrupted);
  // Without per-check verdicts (a result rebuilt by spreading), the transit
  // clock in the payload still answers for the transit data; the flow map
  // carries no clock, so a stale bundle can only be reported as unattributed.
  const transitStale = summariesNode !== null && (failed !== null
    ? failed.includes(TRANSIT_SUMMARIES_CHECK)
    : transitMs === null ? result.stale === true : now - transitMs > TRANSIT_STALE_MS);
  const flowsStale = narratesFlow && failed !== null && failed.includes(CHOKEPOINT_FLOWS_CHECK);
  let caveat = chokepointCaveat(transitStale, transitMs, flowsStale, now, lang);
  if (caveat === undefined && failed === null && result.stale === true && (narratesFlow || rows.length === 0)) {
    caveat = narratesFlow ? say.someStaleFlow : say.someStale;
  }
  const stale = caveat !== undefined;
  const citations: SpokenCitation[] = [{ source: 'WorldMonitor chokepoint monitor (AIS relay and IMF PortWatch)', asOf, stale }];
  const baselines = record(data['chokepoint-baselines']);
  const baselineSource = text(baselines?.source);
  if (baselineSource) citations.push({ source: baselineSource, asOf: toIso(baselines?.updatedAt), stale: failed !== null && failed.includes(CHOKEPOINT_BASELINES_CHECK) });
  if (rows.length === 0) {
    return { sentences: [...say.empty], caveat, citations, stale, asOf };
  }
  const sentences: string[] = [];
  if (single) {
    const row = single;
    sentences.push(row.riskLevel
      ? say.singleRisk(row.name, say.risk(row.riskLevel), incidentsClause(row, lang))
      : say.singleNoRisk(row.name, incidentsClause(row, lang)));
    const flow = flowClause(row, say.flowSubject, lang);
    if (flow) sentences.push(say.flowSentence(flow, row.disrupted));
    else if (row.disrupted) sentences.push(say.disruptedOnly(row.name));
    else if (!flowsKnown) sentences.push(say.flowUnknown);
    if (row.countsAvailable && row.todayTotal !== null) {
      const change = row.wowChangePct !== null && Math.round(Math.abs(row.wowChangePct)) > 0
        ? say.change(row.wowChangePct)
        : '';
      sentences.push(say.transits(row.todayTotal, change));
    } else {
      sentences.push(say.noTransits);
    }
  } else {
    const disrupted = rows.filter((row) => row.disrupted);
    sentences.push(!flowsKnown
      ? say.overviewNoFlows(rows.length)
      : disrupted.length === 0
        ? say.noneDisrupted(rows.length)
        : say.someDisrupted(rows.length, disrupted.length, disrupted.map((row) => row.name)));
    const riskiest = [...rows].filter((row) => row.riskLevel).sort((a, b) => (RISK_RANK[b.riskLevel] ?? -1) - (RISK_RANK[a.riskLevel] ?? -1) || (b.incidents ?? 0) - (a.incidents ?? 0))[0];
    sentences.push(riskiest
      ? say.highest(say.risk(riskiest.riskLevel), riskiest.name, incidentsClause(riskiest, lang))
      : say.noneRated);
    const focus = disrupted[0] ?? riskiest;
    const flow = focus ? flowClause(focus, say.flowThrough(focus.name), lang) : null;
    if (flow) sentences.push(`${flow}.`);
  }
  return { sentences, caveat, citations, stale, asOf };
};

// ---------------------------------------------------------------------------
// get_prediction_markets
// ---------------------------------------------------------------------------
const MARKET_BUCKETS = ['geopolitical', 'tech', 'finance'] as const;
const VENUE_NAMES: Record<string, string> = { polymarket: 'Polymarket', kalshi: 'Kalshi' };

const MARKET_PHRASES = {
  en: {
    bucket: (bucket: string) => bucket,
    price: (price: number | null) => (price === null ? 'an unknown level' : spokenPercent(price)),
    // `appositive` closes a "The leading X market, TITLE, is priced" aside
    // with its second comma; the "Next, TITLE is priced" form takes none.
    clause: (title: string, appositive: boolean, price: string) => `${title}${appositive ? ',' : ''} is priced at ${price}`,
    change: (points: string) => `, ${points} in the past day`,
    empty: (ago: string | null) => [`No prediction markets match those filters${ago === null ? '' : ` as of ${ago}`}.`, 'Try a broader query or another category.'],
    count: (bucket: string, count: number) => (count === 0 ? `none in ${bucket}` : `${spokenInteger(count)} ${bucket}`),
    // With no `cached_at` the stale caveat already says the time is unknown.
    total: (ago: string | null, total: number, counts: string[]) =>
      `Prediction markets${ago === null ? '' : ` as of ${ago}`} track ${spokenCount(total, 'contract')}: ${joinList(counts)}.`,
    lead: (bucket: string, clause: string) => `The leading ${bucket} market, ${clause}.`,
    next: (clause: string) => `Next, ${clause}.`,
  },
  ar: {
    bucket: (bucket: string) => ({ geopolitical: 'الجيوسياسية', tech: 'التقنية', finance: 'المالية' } as Record<string, string>)[bucket] ?? bucket,
    price: (price: number | null) => (price === null ? 'غير معروف' : spokenPercent(price, 'ar')),
    clause: (title: string, _appositive: boolean, price: string) => `${title}، وسعره ${price}`,
    change: (points: string) => `، ${points} خلال اليوم الماضي`,
    empty: (ago: string | null) => [`لا توجد أسواق تنبؤ تطابق هذه المعايير${ago === null ? '' : ` في بيانات صادرة ${ago}`}.`, 'جرّب استعلامًا أوسع أو فئة أخرى.'],
    count: (bucket: string, count: number) => (count === 0 ? `لا شيء في الفئة ${bucket}` : `${spokenInteger(count)} في الفئة ${bucket}`),
    total: (ago: string | null, total: number, counts: string[]) =>
      `عدد العقود في أسواق التنبؤ${ago === null ? '' : `، بحسب بيانات صادرة ${ago}،`} ${spokenInteger(total)}، منها ${joinList(counts, 'ar')}.`,
    lead: (bucket: string, clause: string) => `السوق الأبرز في الفئة ${bucket}: ${clause}.`,
    next: (clause: string) => `يليه: ${clause}.`,
  },
} as const;

function marketClause(market: Record<string, unknown>, lang: SpokenLanguage, appositive = false): string {
  const say = MARKET_PHRASES[lang];
  const change = finite(market.change24h);
  let clause = say.clause(cleanTitle(market.title), appositive, say.price(finite(market.yesPrice)));
  if (change !== null && Math.round(Math.abs(change)) > 0) clause += say.change(spokenPoints(change, lang));
  return clause;
}

function marketCitation(market: Record<string, unknown>, asOf: string | null, stale: boolean): SpokenCitation {
  const url = text(market.url);
  const venue = text(market.source).toLowerCase();
  return { source: VENUE_NAMES[venue] ?? (venue ? humanizeId(venue) : 'Prediction market'), title: cleanTitle(market.title), ...(url ? { url } : {}), asOf, stale };
}

export const spokenPredictionMarkets: SpokenNarrator = (result, _args, now, lang = 'en') => {
  const say = MARKET_PHRASES[lang];
  const freshness = cacheFreshness(result, now, lang);
  const ago = freshness.asOf === null ? null : freshness.ago;
  const bootstrap = record(record(result.data)?.['markets-bootstrap']) ?? {};
  const buckets = MARKET_BUCKETS.map((bucket) => ({
    bucket,
    markets: (Array.isArray(bootstrap[bucket]) ? bootstrap[bucket] as unknown[] : []).map(record).filter((m): m is Record<string, unknown> => m !== null),
  }));
  const total = buckets.reduce((sum, entry) => sum + entry.markets.length, 0);
  const fallback: SpokenCitation = { source: 'WorldMonitor prediction markets', asOf: freshness.asOf, stale: freshness.stale };
  if (total === 0) {
    return {
      sentences: [...say.empty(ago)],
      caveat: freshness.caveat, citations: [fallback], stale: freshness.stale, asOf: freshness.asOf,
    };
  }
  const counts = buckets.map(({ bucket, markets }) => say.count(say.bucket(bucket), markets.length));
  const sentences: string[] = [say.total(ago, total, counts)];
  const spokenMarkets: Record<string, unknown>[] = [];
  const populated = buckets.filter((entry) => entry.markets.length > 0);
  const lead = populated[0]!;
  spokenMarkets.push(lead.markets[0]!);
  sentences.push(say.lead(say.bucket(lead.bucket), marketClause(lead.markets[0]!, lang, true)));
  if (populated.length > 1) {
    const next = populated[1]!;
    spokenMarkets.push(next.markets[0]!);
    sentences.push(say.lead(say.bucket(next.bucket), marketClause(next.markets[0]!, lang, true)));
  } else if (lead.markets.length > 1) {
    spokenMarkets.push(lead.markets[1]!);
    sentences.push(say.next(marketClause(lead.markets[1]!, lang)));
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
const FORECAST_DOMAINS_AR: Record<string, string> = {
  conflict: 'النزاعات',
  market: 'الأسواق',
  supply_chain: 'سلاسل الإمداد',
  political: 'السياسة',
  military: 'الشؤون العسكرية',
  cyber: 'الأمن السيبراني',
  infrastructure: 'البنية التحتية',
};

const FORECAST_PHRASES = {
  en: {
    probability: (probability: number | null) => (probability === null ? 'an unknown probability' : spokenPercent(Math.round(probability * 100))),
    domain: (raw: string) => raw.replace(/[_-]+/g, ' '),
    clause: (probability: string, title: string) => `${probability} for ${title}`,
    kind: (domain: string, region: string) => `, a${domain ? ` ${domain}` : ''} forecast${region ? ` for ${region}` : ''}`,
    change: (points: string) => `, ${points} in the past day`,
    empty: ['No published forecasts match those filters right now.', 'Try another domain or region, or call again without filters.'],
    emptyStale: 'The forecast set is older than its usual refresh, so this may not be the latest picture.',
    total: (count: number, ago: string) => `WorldMonitor currently publishes ${spokenCount(count, 'forecast')}, generated ${ago}; these are AI assessments, not guarantees.`,
    highest: (clause: string) => `The highest probability is ${clause}.`,
    next: (clause: string) => `Next is ${clause}.`,
    stale: 'These forecasts are older than their usual refresh, so treat them as the last known picture.',
  },
  ar: {
    probability: (probability: number | null) => (probability === null ? 'احتمال غير معروف' : spokenPercent(Math.round(probability * 100), 'ar')),
    domain: (raw: string) => FORECAST_DOMAINS_AR[raw] ?? raw.replace(/[_-]+/g, ' '),
    clause: (probability: string, title: string) => `${probability} بشأن: ${title}`,
    kind: (domain: string, region: string) => `، وهو توقع${domain ? ` في مجال ${domain}` : ''}${region ? ` بشأن ${region}` : ''}`,
    change: (points: string) => `، ${points} خلال اليوم الماضي`,
    empty: ['لا توجد توقعات منشورة تطابق هذه المعايير حاليًا.', 'جرّب مجالًا أو منطقة أخرى، أو أعد الطلب دون معايير.'],
    emptyStale: 'مجموعة التوقعات أقدم من موعد تحديثها المعتاد، لذا قد لا تكون هذه أحدث صورة.',
    total: (count: number, ago: string) => `عدد التوقعات التي ينشرها WorldMonitor حاليًا ${spokenInteger(count)}، وقد أُعدّت ${ago}؛ وهي تقييمات صادرة عن الذكاء الاصطناعي وليست ضمانات.`,
    highest: (clause: string) => `أعلى احتمال هو ${clause}.`,
    next: (clause: string) => `يليه ${clause}.`,
    stale: 'هذه التوقعات أقدم من موعد تحديثها المعتاد، لذا اعتبرها آخر صورة معروفة.',
  },
} as const;

function forecastClause(row: Record<string, unknown>, lang: SpokenLanguage, speakChange = true): string {
  const say = FORECAST_PHRASES[lang];
  const rawDomain = text(row.domain);
  const domain = rawDomain ? say.domain(rawDomain) : '';
  const region = cleanTitle(row.region);
  let clause = say.clause(say.probability(finite(row.probability)), cleanTitle(row.title));
  if (domain || region) clause += say.kind(domain, region);
  const change = speakChange ? finite(row.change24h) : null;
  if (change !== null && Math.round(Math.abs(change) * 100) > 0) clause += say.change(spokenPoints(change * 100, lang));
  return clause;
}

// The bundle's `cached_at` and `stale` also cover the probability trail; the
// caveat follows the predictions check alone. The trail feeds only the
// 24-hour move (attachForecastHistory), so that move is spoken only while the
// trail check passes, or, with no per-check verdicts, while the bundle is
// fresh. Keys and the 90-minute budget mirror this tool's _freshnessChecks.
const FORECAST_PREDICTIONS_CHECK = 'seed-meta:forecast:predictions';
const FORECAST_TRAIL_CHECK = 'seed-meta:forecast:probability-trail';
const FORECAST_STALE_MS = 90 * 60_000;

export const spokenForecastPredictions: SpokenNarrator = (result, _args, now, lang = 'en') => {
  const say = FORECAST_PHRASES[lang];
  const node = record(record(result.data)?.predictions);
  const generatedMs = toEpochMs(node?.generatedAt);
  const asOf = generatedMs === null ? null : toIso(generatedMs);
  const failed = staleFreshnessKeys(result);
  const stale = failed !== null
    ? failed.includes(FORECAST_PREDICTIONS_CHECK)
    : generatedMs === null ? result.stale === true : now - generatedMs > FORECAST_STALE_MS;
  const trailFresh = failed !== null ? !failed.includes(FORECAST_TRAIL_CHECK) : result.stale !== true;
  const rows = (Array.isArray(node?.predictions) ? node.predictions as unknown[] : [])
    .map(record)
    .filter((row): row is Record<string, unknown> => row !== null)
    .sort((a, b) => (finite(b.probability) ?? -1) - (finite(a.probability) ?? -1));
  const source = 'WorldMonitor forecasts';
  if (rows.length === 0) {
    return {
      sentences: [...say.empty],
      caveat: stale ? say.emptyStale : undefined,
      citations: [{ source, asOf, stale }], stale, asOf,
    };
  }
  const ago = generatedMs === null ? unknownTime(lang) : spokenAgo(generatedMs, now, lang);
  const sentences = [
    say.total(rows.length, ago),
    say.highest(forecastClause(rows[0]!, lang, trailFresh)),
  ];
  if (rows.length > 1) sentences.push(say.next(forecastClause(rows[1]!, lang, trailFresh)));
  return {
    sentences,
    // The first sentence already speaks the generation age.
    caveat: stale ? say.stale : undefined,
    citations: rows.slice(0, 3).map((row) => ({ source, title: cleanTitle(row.title), asOf, stale })),
    stale,
    asOf,
  };
};

// ---------------------------------------------------------------------------
// get_media_perspective
// ---------------------------------------------------------------------------
const MEDIA_PHRASES = {
  en: {
    window: (hours: number | null) => (hours === null ? 'the look-back window' : `the past ${spokenInteger(hours)} hours`),
    unavailable: (name: string) => [`Media coverage for ${name} is unavailable right now.`, 'Please try again later.'],
    partial: 'Some feeds were unavailable, so this is a partial view.',
    none: (name: string, window: string) => [`No headlines mentioning ${name} were found in ${window}.`, 'Try a longer window or different outlet filters.'],
    countPhrase: (count: number) => (count === 0 ? 'none' : spokenInteger(count)),
    coverage: (window: string, total: number, outlets: number, name: string, own: string, foreignFacing: string, outside: string) =>
      `Over ${window}, ${spokenCount(total, 'headline')} from ${spokenCount(outlets, 'outlet')} covered ${name}: ${own} from its own press, ${foreignFacing} from its foreign-facing media and ${outside} from outside coverage.`,
    noStance: 'No model stance labels are available for these headlines yet.',
    stance: (labelled: number, favorable: number, neutral: number, critical: number) =>
      `Of the ${spokenCount(labelled, 'headline')} a model labelled for stance, ${spokenInteger(favorable)} read as favorable, ${spokenInteger(neutral)} neutral and ${spokenInteger(critical)} critical or hostile.`,
    latest: (outlet: string, title: string) => `The most recent is from ${outlet}: ${title}.`,
    anOutlet: 'an outlet',
  },
  ar: {
    window: (hours: number | null) => (hours === null ? 'فترة البحث' : `آخر ${arabicHours(hours)}`),
    unavailable: (name: string) => [`التغطية الإعلامية عن ${name} غير متاحة الآن.`, 'يُرجى المحاولة لاحقًا.'],
    partial: 'تعذّر الوصول إلى بعض المصادر، لذا هذه صورة جزئية.',
    none: (name: string, window: string) => [`لم يُعثر على عناوين تذكر ${name} خلال ${window}.`, 'جرّب فترة أطول أو مرشحات مختلفة للمنافذ الإعلامية.'],
    countPhrase: (count: number) => (count === 0 ? 'لا شيء' : spokenInteger(count)),
    coverage: (window: string, total: number, outlets: number, name: string, own: string, foreignFacing: string, outside: string) =>
      `خلال ${window}، بلغ عدد العناوين التي تناولت ${name} ${spokenInteger(total)}، نشرتها منافذ إعلامية عددها ${spokenInteger(outlets)}: ${own} من الصحافة المحلية للبلد، و${foreignFacing} من إعلامه الموجّه إلى الخارج، و${outside} من التغطية الخارجية.`,
    noStance: 'لا تتوفر بعد تصنيفات للموقف التحريري أعدّها نموذج لهذه العناوين.',
    stance: (labelled: number, favorable: number, neutral: number, critical: number) =>
      `من العناوين التي صنّف نموذجٌ موقفها، وعددها ${spokenInteger(labelled)}، ${spokenInteger(favorable)} إيجابية، و${spokenInteger(neutral)} محايدة، و${spokenInteger(critical)} ناقدة أو عدائية.`,
    latest: (outlet: string, title: string) => `أحدثها من ${outlet}: ${title}.`,
    anOutlet: 'منفذ إعلامي',
  },
} as const;

export const spokenMediaPerspective: SpokenNarrator = (result, args, _now, lang = 'en') => {
  const say = MEDIA_PHRASES[lang];
  const subject = text(result.subjectCountry) || text(args.subject_country).toUpperCase();
  const name = countryName(subject, undefined, lang);
  const asOf = toIso(result.readAt);
  const state = text(result.state);
  const windowPhrase = say.window(finite(result.windowHours));
  const fallback: SpokenCitation = { source: 'WorldMonitor media perspective', asOf, stale: state !== 'complete' };
  if (state === 'unavailable') {
    return { sentences: [...say.unavailable(name)], citations: [fallback], stale: true, asOf };
  }
  const groups = (Array.isArray(result.groups) ? result.groups : []).map(record).filter((g): g is Record<string, unknown> => g !== null);
  const headlineCount = (group: Record<string, unknown>) => finite(group.headlineCount) ?? (Array.isArray(group.headlines) ? group.headlines.length : 0);
  const total = groups.reduce((sum, group) => sum + headlineCount(group), 0);
  const outlets = groups.reduce((sum, group) => sum + (finite(group.outletCount) ?? 0), 0);
  const partial = state === 'partial';
  const caveat = partial ? say.partial : undefined;
  if (total === 0) {
    return { sentences: [...say.none(name, windowPhrase)], caveat, citations: [fallback], stale: partial, asOf };
  }
  let own = 0; let foreignFacing = 0; let outside = 0;
  const framing = { favorable: 0, neutral: 0, critical: 0, hostile: 0 };
  const headlines: Array<{ outlet: string; title: string; spokenTitle: string; url: string; publishedAt: number | null }> = [];
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
      // An Arabic answer reads a headline published in Arabic as written;
      // every other headline is read in its English rendering, as in English.
      // Citations keep the English rendering in both languages: they describe
      // the source, not the wording of the answer.
      const original = lang === 'ar' && text(headline.titleLanguage) === 'ar' ? cleanTitle(headline.title, 120, 'ar') : '';
      headlines.push({ outlet: text(headline.outlet) || say.anOutlet, title, spokenTitle: original || title, url: text(headline.link), publishedAt: toEpochMs(headline.publishedAt) });
    }
  }
  const sentences = [
    say.coverage(windowPhrase, total, outlets, name, say.countPhrase(own), say.countPhrase(foreignFacing), say.countPhrase(outside)),
  ];
  const labelled = framing.favorable + framing.neutral + framing.critical + framing.hostile;
  // Stance is a model's reading of each headline, not WorldMonitor's view;
  // the sentence says so, as the tool description does.
  sentences.push(labelled === 0
    ? say.noStance
    : say.stance(labelled, framing.favorable, framing.neutral, framing.critical + framing.hostile));
  headlines.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  const latest = headlines[0];
  if (latest) sentences.push(say.latest(latest.outlet, latest.spokenTitle));
  const citations: SpokenCitation[] = headlines.slice(0, 6).map((headline) => ({
    source: headline.outlet, title: headline.title, ...(headline.url ? { url: headline.url } : {}),
    asOf: headline.publishedAt === null ? asOf : toIso(headline.publishedAt), stale: partial,
  }));
  return { sentences, caveat, citations: citations.length > 0 ? citations : [fallback], stale: partial, asOf };
};

// ---------------------------------------------------------------------------
// get_resilience_indicators
// ---------------------------------------------------------------------------
const DIMENSION_LABELS: Record<SpokenLanguage, Record<string, string>> = {
  en: {
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
  },
  ar: {
    macroFiscal: 'المالية العامة',
    currencyExternal: 'العملة والتوازن الخارجي',
    tradePolicy: 'السياسة التجارية',
    financialSystemExposure: 'انكشاف النظام المالي',
    cyberDigital: 'الأمن السيبراني والرقمي',
    logisticsSupply: 'اللوجستيات والإمداد',
    infrastructure: 'البنية التحتية',
    energy: 'الطاقة',
    governanceInstitutional: 'الحوكمة',
    socialCohesion: 'التماسك الاجتماعي',
    borderSecurity: 'أمن الحدود',
    informationCognitive: 'البيئة المعلوماتية',
  },
};

const RESILIENCE_PHRASES = {
  en: {
    empty: (name: string) => [`No resilience breakdown is available for ${name} right now.`, 'Please try again later.'],
    data: (month: string | null) => (month ? `data from ${month}` : 'the current data snapshot'),
    covers: (name: string, count: number, data: string) => `${name}'s resilience breakdown covers ${spokenCount(count, 'dimension')}, using ${data}.`,
    at: (label: string, score: number) => `${label} at ${spokenInteger(score)}`,
    only: (a: string) => `Its only scored dimension is ${a}.`,
    pair: (strongest: string, weakest: string) => `Its strongest area is ${strongest}, and its weakest is ${weakest}.`,
    four: (s1: string, s2: string, w1: string, w2: string) => `Its strongest areas are ${s1} and ${s2}, and its weakest are ${w1} and ${w2}.`,
    imputed: (count: number) => `${spokenInteger(count)} imputed`,
    failed: (count: number) => `${spokenInteger(count)} from a failed source`,
    missing: (count: number) => `${spokenInteger(count)} missing`,
    allObserved: (count: number) => `All ${spokenCount(count, 'active indicator')} are directly observed.`,
    someObserved: (observed: number, count: number, gaps: string[]) =>
      `${spokenInteger(observed)} of ${spokenCount(count, 'active indicator')} are directly observed, with ${joinList(gaps)}.`,
  },
  ar: {
    empty: (name: string) => [`لا يتوفر تفصيل لمؤشر الصمود عن ${name} حاليًا.`, 'يُرجى المحاولة لاحقًا.'],
    data: (month: string | null) => (month ? `بيانات ${month}` : 'لقطة البيانات الحالية'),
    covers: (name: string, count: number, data: string) => `يغطي تفصيل مؤشر الصمود عن ${name} أبعادًا عددها ${spokenInteger(count)}، استنادًا إلى ${data}.`,
    at: (label: string, score: number) => `${label} بدرجة ${spokenInteger(score)}`,
    only: (a: string) => `البعد الوحيد الذي حصل على درجة هو ${a}.`,
    pair: (strongest: string, weakest: string) => `أقوى المجالات ${strongest}، وأضعفها ${weakest}.`,
    four: (s1: string, s2: string, w1: string, w2: string) => `أقوى المجالات ${s1} و${s2}، وأضعفها ${w1} و${w2}.`,
    imputed: (count: number) => `${spokenInteger(count)} مقدّرة إحصائيًا`,
    failed: (count: number) => `${spokenInteger(count)} من مصدر متعطل`,
    missing: (count: number) => `${spokenInteger(count)} مفقودة`,
    allObserved: (count: number) => `جميع المؤشرات النشطة، وعددها ${spokenInteger(count)}، مرصودة مباشرة.`,
    someObserved: (observed: number, count: number, gaps: string[]) =>
      `عدد المؤشرات النشطة المرصودة مباشرة ${spokenInteger(observed)} من أصل ${spokenInteger(count)}، والباقي: ${joinList(gaps, 'ar')}.`,
  },
} as const;

export const spokenResilienceIndicators: SpokenNarrator = (result, args, _now, lang = 'en') => {
  const say = RESILIENCE_PHRASES[lang];
  // The tool accepts country names (#9722); speak the resolved country, never the raw argument.
  const code = text(result.countryCode) || resolveCountryArg(args.country_code) || '';
  const name = countryName(code, undefined, lang);
  const dataVersion = text(result.dataVersion);
  const asOf = toIso(dataVersion);
  const citations: SpokenCitation[] = [{ source: 'WorldMonitor resilience score', asOf, stale: false }];
  const dimensions = (Array.isArray(result.dimensions) ? result.dimensions : [])
    .map(record)
    .filter((d): d is Record<string, unknown> => d !== null && d.active !== false && d.reconciliationAvailable !== false && finite(d.score) !== null)
    .map((d) => ({ label: DIMENSION_LABELS[lang][text(d.id)] ?? humanizeId(text(d.id)).toLowerCase(), score: finite(d.score)! }))
    .sort((a, b) => b.score - a.score);
  if (dimensions.length === 0) {
    return { sentences: [...say.empty(name)], citations, stale: true, asOf };
  }
  const sentences = [say.covers(name, dimensions.length, say.data(spokenMonthYear(dataVersion, lang)))];
  const at = (d: { label: string; score: number }) => say.at(d.label, d.score);
  if (dimensions.length === 1) sentences.push(say.only(at(dimensions[0]!)));
  else if (dimensions.length < 4) sentences.push(say.pair(at(dimensions[0]!), at(dimensions[dimensions.length - 1]!)));
  else {
    const weakest = dimensions.slice(-2).reverse();
    sentences.push(say.four(at(dimensions[0]!), at(dimensions[1]!), at(weakest[0]!), at(weakest[1]!)));
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
    if (imputed > 0) gaps.push(say.imputed(imputed));
    if (failed > 0) gaps.push(say.failed(failed));
    if (missing > 0) gaps.push(say.missing(missing));
    sentences.push(observed === active.length
      ? say.allObserved(active.length)
      : say.someObserved(observed, active.length, gaps));
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
