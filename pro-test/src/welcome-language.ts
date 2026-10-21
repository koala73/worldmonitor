type TranslationRecord = Record<string, unknown>;

function isRecord(value: unknown): value is TranslationRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => deepEqualJson(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => (
      Object.prototype.hasOwnProperty.call(right, key)
      && deepEqualJson(left[key], right[key])
    ));
}

// Traditional Chinese is its own written standard, not a region of `zh`, so
// these tags must resolve before the region suffix is stripped. Declared here
// rather than in i18n.ts because i18n.ts already imports this module; keeping
// the set in one place stops the two copies drifting apart.
const TRADITIONAL_CHINESE_TAGS = new Set(['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant']);

export function isTraditionalChineseTag(tag: string): boolean {
  const lower = (tag || '').toLowerCase();
  return TRADITIONAL_CHINESE_TAGS.has(lower) || lower.startsWith('zh-hant');
}

export function resolveEffectiveWelcomeContentLanguage(
  currentLanguage: string,
  englishWelcome: unknown,
  currentResources: TranslationRecord | undefined,
): string {
  // `fr-FR` still collapses to `fr` — one dictionary per language. But a
  // Traditional-Chinese tag names a dictionary of its own, and the caller looks
  // the resource bundle up under the code returned here, so stripping it would
  // hand a zh-TW reader the Simplified `zh` bundle they never loaded.
  const base = isTraditionalChineseTag(currentLanguage)
    ? 'zh-TW'
    : (currentLanguage || 'en').split('-')[0]?.toLowerCase() || 'en';
  if (base === 'en') return 'en';
  if (!currentResources || !Object.prototype.hasOwnProperty.call(currentResources, 'welcome')) {
    return 'en';
  }

  const localizedWelcome = currentResources.welcome;
  if (!isRecord(localizedWelcome) || deepEqualJson(localizedWelcome, englishWelcome)) {
    return 'en';
  }
  return base;
}
