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

export function resolveEffectiveWelcomeContentLanguage(
  currentLanguage: string,
  englishWelcome: unknown,
  currentResources: TranslationRecord | undefined,
): string {
  const base = (currentLanguage || 'en').split('-')[0]?.toLowerCase() || 'en';
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
