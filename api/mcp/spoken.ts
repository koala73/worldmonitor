import { displayNameForIso2 } from '../../server/_shared/country-normalize';
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

export type SpokenNarrator = (result: Record<string, unknown>, args: Record<string, unknown>, now: number) => SpokenNarration;

export interface SpokenEnvelope {
  tool: string;
  spoken: string;
  citations: SpokenCitation[];
  stale: boolean;
  asOf: string | null;
}

export function buildSpokenEnvelope(
  tool: { name: string; _spoken?: SpokenNarrator },
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  now = Date.now(),
): SpokenEnvelope {
  if (!tool._spoken) throw new Error(`${tool.name} has no spoken narrator`);
  const narration = tool._spoken(result, args, now);
  const spoken = narration.sentences.map(cleanSpeech).filter((sentence) => sentence.length > 0);
  const caveat = narration.caveat === undefined ? undefined : cleanSpeech(narration.caveat);
  return {
    tool: tool.name,
    spoken: fitSpeech(spoken, caveat),
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
export function cleanSpeech(text: string): string {
  let out = text
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/\[\d+\]/g, '')
    .replace(/[*_`#|<>{}[\]]/g, '')
    .replace(/\s*\(([^)]*)\)/g, (_match, inner: string) => (inner.trim() ? `, ${inner.trim()}` : ''))
    .replace(/%/g, ' percent')
    .replace(/\b(?:[A-Z]\.){2,}/g, (abbr) => abbr.replace(/\./g, ''))
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length === 0) return out;
  out = out.replace(/[,;:]+$/, '');
  if (!/[.!?]$/.test(out)) out += '.';
  return out;
}

/** A title or headline as it can sit inside a sentence: no markup, no terminal punctuation, bounded. */
export function cleanTitle(value: unknown, maxChars = 120): string {
  if (typeof value !== 'string') return '';
  let title = cleanSpeech(value).replace(/[.!?]+$/, '').trim();
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

export function spokenPercent(value: number): string {
  return `${spokenNumber(value)} percent`;
}

/** A move in whole points: "up 3 points", "down 1 point", or "unchanged". */
export function spokenPoints(delta: number): string {
  const points = Math.round(Math.abs(delta));
  if (points === 0) return 'unchanged';
  return `${delta > 0 ? 'up' : 'down'} ${points} ${points === 1 ? 'point' : 'points'}`;
}

export function spokenCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${spokenInteger(count)} ${count === 1 ? singular : plural}`;
}

/** Relative age for speech: "moments ago", "about 25 minutes ago", "about 2 hours ago", "about 3 days ago". */
export function spokenAgo(then: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 2) return 'moments ago';
  if (minutes < 60) return `about ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `about ${days} days ago`;
}

export function spokenMonthYear(value: unknown): string | null {
  const ms = toEpochMs(value);
  if (ms === null) return null;
  return new Date(ms).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "a", "a and b", "a, b and c". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
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

export function countryName(code: unknown, fallback?: unknown): string {
  const name = displayNameForIso2(code);
  if (name) return name;
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
  return typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : 'this country';
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
export function cacheFreshness(result: Record<string, unknown>, now: number): { asOf: string | null; stale: boolean; caveat?: string; ago: string } {
  const asOf = toIso(result.cached_at);
  const stale = result.stale === true;
  const cachedMs = toEpochMs(result.cached_at);
  const ago = cachedMs === null ? 'at an unknown time' : spokenAgo(cachedMs, now);
  const caveat = stale
    ? `This snapshot was taken ${ago} and is flagged as stale, so some figures may be out of date.`
    : undefined;
  return { asOf, stale, caveat, ago };
}
