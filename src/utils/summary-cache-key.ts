// IMPORTANT: This module is the canonical cache-key builder shared by both
// client (src/) and server (server/ via _shared.ts re-export). It imports
// hashString from src/utils/hash.ts — do NOT swap to server/_shared/hash.ts
// or client/server cache keys will silently diverge.
import { hashString } from './hash';

export const CACHE_VERSION = 'v5';

const MAX_HEADLINE_LEN = 500;
const MAX_HEADLINES_FOR_KEY = 5;
const MAX_GEO_CONTEXT_LEN = 2000;

export function canonicalizeSummaryInputs(headlines: string[], geoContext?: string) {
  return {
    headlines: headlines.slice(0, 10).map(h => typeof h === 'string' ? h.slice(0, MAX_HEADLINE_LEN) : ''),
    geoContext: typeof geoContext === 'string' ? geoContext.slice(0, MAX_GEO_CONTEXT_LEN) : '',
  };
}

export function buildSummaryCacheKey(
  headlines: string[],
  mode: string,
  geoContext?: string,
  variant?: string,
  lang?: string,
): string {
  const canon = canonicalizeSummaryInputs(headlines, geoContext);
  const sorted = canon.headlines.slice(0, MAX_HEADLINES_FOR_KEY).sort().join('|');
  const geoHash = canon.geoContext ? ':g' + hashString(canon.geoContext).slice(0, 6) : '';
  const hash = hashString(`${mode}:${sorted}`);
  const normalizedVariant = typeof variant === 'string' && variant ? variant.toLowerCase() : 'full';
  const normalizedLang = typeof lang === 'string' && lang ? lang.toLowerCase() : 'en';

  if (mode === 'SUMMARIZE_MODE_TRANSLATE') {
    const targetLang = normalizedVariant || normalizedLang;
    return `summary:${CACHE_VERSION}:${mode}:${targetLang}:${hash}${geoHash}`;
  }

  return `summary:${CACHE_VERSION}:${mode}:${normalizedVariant}:${normalizedLang}:${hash}${geoHash}`;
}
