import { sanitizeForPrompt, sanitizeHeadlines } from '../../../_shared/llm-sanitize.js';

const SUPPORTED_TRANSLATE_LANGS = new Set([
  'en', 'fr', 'de', 'el', 'es', 'it', 'pl', 'pt', 'nl', 'sv',
  'ru', 'ar', 'zh', 'ja', 'tr', 'th', 'vi',
]);

function normalizeLangCode(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().split('-')[0] || '';
}

export function normalizeTranslateTargetLang(variant = '', lang = 'en') {
  const requested = normalizeLangCode(variant);
  if (SUPPORTED_TRANSLATE_LANGS.has(requested)) return requested;

  const fallback = normalizeLangCode(lang);
  if (SUPPORTED_TRANSLATE_LANGS.has(fallback)) return fallback;

  return 'en';
}

export function preparePromptInputs({
  headlines,
  mode = 'brief',
  geoContext = '',
  variant = 'full',
  lang = 'en',
  maxHeadlines = 10,
  maxHeadlineLen = 500,
  maxGeoContextLen = 2000,
}) {
  const boundedHeadlines = (Array.isArray(headlines) ? headlines : [])
    .slice(0, maxHeadlines)
    .map(h => typeof h === 'string' ? h.slice(0, maxHeadlineLen) : '');

  const promptHeadlines = mode === 'translate'
    ? boundedHeadlines
    : sanitizeHeadlines(boundedHeadlines);

  const promptGeoContext = typeof geoContext === 'string'
    ? sanitizeForPrompt(geoContext.slice(0, maxGeoContextLen))
    : '';

  const promptVariant = mode === 'translate'
    ? normalizeTranslateTargetLang(variant, lang)
    : variant;

  return {
    headlines: promptHeadlines,
    geoContext: promptGeoContext,
    variant: promptVariant,
    safeVariant: promptVariant,
  };
}
