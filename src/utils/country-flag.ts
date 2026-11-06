

const COUNTRY_CODE_RE = /^[A-Z]{2}$/;
export function toFlagEmoji(code: string, fallback = '🌍'): string {
  const upperCode = code.trim().toUpperCase();
  if (!COUNTRY_CODE_RE.test(upperCode)) return fallback;

  return upperCode
    .split('')
    .map((char) => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65))
    .join('');
}
