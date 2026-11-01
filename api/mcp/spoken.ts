import { displayNameForIso2 } from '../../server/_shared/country-normalize';
import { arabicCountryDisplayName } from '../../shared/country-code-resolve-arabic';
import { isPlainObject } from './utils';

// ---------------------------------------------------------------------------
// `response_mode: "spoken"` (#9722, voice and avatar consumers)
//
// A voice or avatar agent reads a tool answer aloud. The documented payload is
// the wrong shape for that: large, numeric, and full of field names. A tool
// that declares `_spoken` can instead answer with 2-3 short plain-language
// sentences plus a `citations` list the agent can show or log.
//
// The sentences are TEMPLATED from the tool's own structured data, never
// written by a model at request time: no latency, no provider cost, the same
// answer for the same data, and every number in the sentence is one the
// payload carries. A tool whose payload already holds model-written prose
// (the world brief) still narrates from its structured fields, so the spoken
// text cannot pick up markdown, citation markers or links from that prose.
//
// `summary` is the context-budget feature (counts and samples instead of
// lists); it is a different question from "say this aloud", so the spoken
// mode is its own argument rather than a third value of `summary`, and the
// two cannot be combined: the sentences need the full lists.
// ---------------------------------------------------------------------------

export const RESPONSE_MODE_SCHEMA: { type: 'string'; enum: string[]; description: string } = {
  type: 'string',
  enum: ['full', 'spoken'],
  description: '"spoken" returns 2-3 plain-language sentences for text-to-speech plus structured citations instead of the full payload; "full" (default) returns the documented shape.',
};

// `spoken_language` (#9722, "Arabic queries and answers over MCP"). The
// narrators keep one data path and pick their sentence wording by language,
// so an Arabic answer speaks exactly the numbers the English one does.
// Numbers stay in Western digits, which every Arabic TTS voice reads.
// Headlines, market and forecast titles are data, not template text, and stay
// in the language they were published in.
export const SPOKEN_LANGUAGES = ['en', 'ar'] as const;
export type SpokenLanguage = (typeof SPOKEN_LANGUAGES)[number];

export const SPOKEN_LANGUAGE_SCHEMA: { type: 'string'; enum: string[]; description: string } = {
  type: 'string',
  enum: [...SPOKEN_LANGUAGES],
  description: 'Language of the spoken sentences, used only with response_mode "spoken": "en" (default) or "ar" (Modern Standard Arabic). Numbers stay in Western digits; headline and market titles keep their source language.',
};

export function spokenLanguageOf(value: unknown): SpokenLanguage {
  return value === 'ar' ? 'ar' : 'en';
}

export const SPOKEN_MAX_CHARS = 500;
export const SPOKEN_MAX_SENTENCES = 3;

export interface SpokenCitation {
  source: string;
  title?: string;
  url?: string;
  // ISO-8601, or null when the payload carries no time for this source.
  asOf: string | null;
  stale: boolean;
}

export interface SpokenNarration {
  // Two or more sentences, in speaking order. Each must stand alone.
  sentences: string[];
  // Freshness or availability caveat. When present it is always spoken and
  // takes the last slot, displacing the third sentence.
  caveat?: string;
  citations: SpokenCitation[];
  stale: boolean;
  asOf: string | null;
}

export type SpokenNarrator = (
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  now: number,
  lang: SpokenLanguage,
) => SpokenNarration;

export interface SpokenEnvelope {
  tool: string;
  spoken: string;
  language: SpokenLanguage;
  citations: SpokenCitation[];
  stale: boolean;
  asOf: string | null;
}

export function buildSpokenEnvelope(
  tool: { name: string; _spoken?: SpokenNarrator },
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  now = Date.now(),
  lang: SpokenLanguage = 'en',
): SpokenEnvelope {
  if (!tool._spoken) throw new Error(`${tool.name} has no spoken narrator`);
  const narration = tool._spoken(result, args, now, lang);
  const spoken = narration.sentences.map((sentence) => cleanSpeech(sentence, lang)).filter((sentence) => sentence.length > 0);
  const caveat = narration.caveat === undefined ? undefined : cleanSpeech(narration.caveat, lang);
  return {
    tool: tool.name,
    spoken: fitSpeech(spoken, caveat),
    language: lang,
    citations: narration.citations.map((citation) => ({
      source: citation.source,
      ...(citation.title === undefined ? {} : { title: citation.title }),
      ...(citation.url === undefined ? {} : { url: citation.url }),
      asOf: citation.asOf,
      stale: citation.stale,
    })),
    stale: narration.stale,
    asOf: narration.asOf,
  };
}

/**
 * Keep the narration within the documented bounds: at most three sentences
 * and SPOKEN_MAX_CHARS characters. A caveat is always spoken and takes the
 * last slot. Over the character limit, trailing body sentences go first
 * (never below two sentences in total); if one sentence is still too long,
 * the longest body sentence is cut at a word boundary and closed with a full
 * stop, so the listener hears complete sentences, not a mid-word cutoff.
 */
export function fitSpeech(sentences: string[], caveat?: string): string {
  const body = caveat ? sentences.slice(0, SPOKEN_MAX_SENTENCES - 1) : sentences.slice(0, SPOKEN_MAX_SENTENCES);
  const minBody = caveat ? 1 : 2;
  const assemble = () => (caveat ? [...body, caveat] : body).join(' ');
  while (body.length > minBody && assemble().length > SPOKEN_MAX_CHARS) body.pop();
  let excess = assemble().length - SPOKEN_MAX_CHARS;
  while (excess > 0 && body.length > 0) {
    const longest = body.reduce((best, sentence, index) => (sentence.length > body[best]!.length ? index : best), 0);
    const shortened = shortenSentence(body[longest]!, body[longest]!.length - excess);
    if (shortened === body[longest]) break;
    body[longest] = shortened;
    excess = assemble().length - SPOKEN_MAX_CHARS;
  }
  return assemble();
}

function shortenSentence(sentence: string, limit: number): string {
  if (sentence.length <= limit) return sentence;
  const cut = sentence.slice(0, Math.max(1, limit - 1));
  const space = cut.lastIndexOf(' ');
  const head = (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:\-–—]+$/, '');
  return head.length > 0 ? `${head}.` : sentence;
}

// ---------------------------------------------------------------------------
// Speech helpers shared by the narrators. Everything a sentence interpolates
// goes through one of these so the spoken text never carries markdown,
// links, percent signs, parentheses or dotted abbreviations a TTS engine
// would stumble on.
// ---------------------------------------------------------------------------

/** Final pass over one sentence: strip markup and links, settle punctuation. */
export function cleanSpeech(text: string, lang: SpokenLanguage = 'en'): string {
  // Arabic prose takes the Arabic comma, and a percent sign is read "في المئة".
  const comma = lang === 'ar' ? '،' : ',';
  let out = text
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/\[\d+\]/g, '')
    .replace(/[*_`#|<>{}[\]]/g, '')
    .replace(/\s*\(([^)]*)\)/g, (_match, inner: string) => (inner.trim() ? `${comma} ${inner.trim()}` : ''))
    .replace(/[%٪]/g, lang === 'ar' ? ' في المئة' : ' percent')
    .replace(/\b(?:[A-Z]\.){2,}/g, (abbr) => abbr.replace(/\./g, ''))
    .replace(/\s+([,،])/g, '$1')
    .replace(/([,،])\s*[,،]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length === 0) return out;
  out = out.replace(/[,;:،؛]+$/, '');
  if (!/[.!?؟]$/.test(out)) out += '.';
  return out;
}

/** A title or headline as it can sit inside a sentence: no markup, no terminal punctuation, bounded. */
export function cleanTitle(value: unknown, maxChars = 120, lang: SpokenLanguage = 'en'): string {
  if (typeof value !== 'string') return '';
  let title = cleanSpeech(value, lang).replace(/[.!?؟]+$/, '').trim();
  if (title.length > maxChars) {
    const cut = title.slice(0, maxChars);
    const space = cut.lastIndexOf(' ');
    title = (space > maxChars / 2 ? cut.slice(0, space) : cut).replace(/[,;:\-–—]+$/, '').trim();
  }
  return title;
}

export function spokenInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** Whole numbers at 10 and above; one decimal below that. */
export function spokenNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value) || Math.abs(value) >= 10) return spokenInteger(value);
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function spokenPercent(value: number, lang: SpokenLanguage = 'en'): string {
  return `${spokenNumber(value)} ${lang === 'ar' ? 'في المئة' : 'percent'}`;
}

/**
 * The forms an Arabic noun takes after a number, by CLDR plural category:
 * one (1, the noun alone, "ساعة"), two (2, the dual, "ساعتين"), few (3-10,
 * the plural, "ساعات"), many (11-99, singular accusative, "ساعة"), and other
 * (100 and up, singular genitive; defaults to `many`). Zero takes the plural.
 */
export interface ArabicCountForms {
  one: string;
  two: string;
  few: string;
  many: string;
  other?: string;
}

const ARABIC_PLURAL = new Intl.PluralRules('ar');

/** "ساعة", "ساعتين", "3 ساعات", "15 ساعة": a counted Arabic noun with its number where the grammar speaks one. */
export function arabicCount(count: number, forms: ArabicCountForms): string {
  const n = Math.round(Math.abs(count));
  switch (ARABIC_PLURAL.select(n)) {
    case 'one': return forms.one;
    case 'two': return forms.two;
    case 'many': return `${spokenInteger(n)} ${forms.many}`;
    case 'other': return `${spokenInteger(n)} ${forms.other ?? forms.many}`;
    default: return `${spokenInteger(n)} ${forms.few}`;
  }
}

const AR_POINTS: ArabicCountForms = { one: 'نقطة واحدة', two: 'نقطتين', few: 'نقاط', many: 'نقطة' };
const AR_MINUTES: ArabicCountForms = { one: 'دقيقة', two: 'دقيقتين', few: 'دقائق', many: 'دقيقة' };
const AR_HOURS: ArabicCountForms = { one: 'ساعة', two: 'ساعتين', few: 'ساعات', many: 'ساعة' };
const AR_DAYS: ArabicCountForms = { one: 'يوم', two: 'يومين', few: 'أيام', many: 'يومًا', other: 'يوم' };

/** Hours as an Arabic phrase: "ساعة", "ساعتين", "72 ساعة". */
export function arabicHours(hours: number): string {
  return arabicCount(hours, AR_HOURS);
}

/** A move in whole points: "up 3 points", "down 1 point", or "unchanged". */
export function spokenPoints(delta: number, lang: SpokenLanguage = 'en'): string {
  const points = Math.round(Math.abs(delta));
  if (lang === 'ar') {
    if (points === 0) return 'دون تغيير';
    return `${delta > 0 ? 'بارتفاع' : 'بانخفاض'} ${arabicCount(points, AR_POINTS)}`;
  }
  if (points === 0) return 'unchanged';
  return `${delta > 0 ? 'up' : 'down'} ${points} ${points === 1 ? 'point' : 'points'}`;
}

export function spokenCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${spokenInteger(count)} ${count === 1 ? singular : plural}`;
}

/** Relative age for speech: "moments ago", "about 25 minutes ago", "about 2 hours ago", "about 3 days ago". */
export function spokenAgo(then: number, now: number, lang: SpokenLanguage = 'en'): string {
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  if (lang === 'ar') {
    if (minutes < 2) return 'قبل لحظات';
    if (minutes < 60) return `قبل نحو ${arabicCount(minutes, AR_MINUTES)}`;
    if (hours < 48) return `قبل نحو ${arabicCount(hours, AR_HOURS)}`;
    return `قبل نحو ${arabicCount(days, AR_DAYS)}`;
  }
  if (minutes < 2) return 'moments ago';
  if (minutes < 60) return `about ${minutes} minutes ago`;
  if (hours < 48) return `about ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  return `about ${days} days ago`;
}

export function spokenMonthYear(value: unknown, lang: SpokenLanguage = 'en'): string | null {
  const ms = toEpochMs(value);
  if (ms === null) return null;
  // `nu-latn` keeps the year in Western digits, like every other number spoken.
  return new Date(ms).toLocaleDateString(lang === 'ar' ? 'ar-u-nu-latn' : 'en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "a", "a and b", "a, b and c"; in Arabic "أ وب", "أ، ب وج" (the conjunction attaches to its word). */
export function joinList(items: string[], lang: SpokenLanguage = 'en'): string {
  if (items.length <= 1) return items[0] ?? '';
  if (lang === 'ar') return `${items.slice(0, -1).join('، ')} و${items[items.length - 1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** `hormuz_strait` -> "Hormuz Strait", `macroFiscal` -> "Macro Fiscal". */
export function humanizeId(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function countryName(code: unknown, fallback?: unknown, lang: SpokenLanguage = 'en'): string {
  if (lang === 'ar') {
    const arabic = arabicCountryDisplayName(code);
    if (arabic) return arabic;
  }
  const name = displayNameForIso2(code);
  if (name) return name;
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
  if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase();
  return lang === 'ar' ? 'هذا البلد' : 'this country';
}

/** Epoch milliseconds from an ISO string, an epoch number, or null when unparseable or non-positive. */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toIso(value: unknown): string | null {
  const ms = toEpochMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

export function record(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Cache-tool freshness, read from the standard `{cached_at, stale}` envelope. */
export function cacheFreshness(result: Record<string, unknown>, now: number, lang: SpokenLanguage = 'en'): { asOf: string | null; stale: boolean; caveat?: string; ago: string } {
  const asOf = toIso(result.cached_at);
  const stale = result.stale === true;
  const cachedMs = toEpochMs(result.cached_at);
  const ago = cachedMs === null ? unknownTime(lang) : spokenAgo(cachedMs, now, lang);
  const caveat = !stale
    ? undefined
    : lang === 'ar'
      ? `أُخذت هذه اللقطة ${ago} وهي مصنفة على أنها قديمة، لذا قد لا تكون بعض الأرقام محدّثة.`
      : `This snapshot was taken ${ago} and is flagged as stale, so some figures may be out of date.`;
  return { asOf, stale, caveat, ago };
}

/** The phrase for an unknown time, in the place a relative age would stand. */
export function unknownTime(lang: SpokenLanguage = 'en'): string {
  return lang === 'ar' ? 'في وقت غير معروف' : 'at an unknown time';
}

// A bundle's `cached_at` is the OLDEST fetch across its keys and its `stale`
// is true when ANY key misses its budget, so neither says anything about the
// key a sentence narrates: a static reference table (an annual baselines key
// on a 400-day budget) sets the age, and an unnarrated index can trip stale.
// Dispatch records which freshness checks failed against the result object it
// returns, so a narrator can caveat only the data it speaks. Held in a
// WeakMap, not on the payload, so the documented wire shape is untouched. A
// result rebuilt by spreading (panel snapshots, receipts) carries no entry, and
// the narrator then falls back to the timestamps in the payload itself.
const staleCheckKeys = new WeakMap<object, readonly string[]>();

export function recordStaleFreshnessKeys(result: object, keys: readonly string[]): void {
  staleCheckKeys.set(result, [...keys]);
}

/** The freshness-check keys that failed for this result, or null when dispatch recorded none. */
export function staleFreshnessKeys(result: object): readonly string[] | null {
  return staleCheckKeys.get(result) ?? null;
}
