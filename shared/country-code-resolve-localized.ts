import COUNTRY_NAMES from './country-names-localized.json';
import ENGLISH_NAMES from './country-names.json';
import { resolveCountryCode } from './country-code-resolve';
import { resolveArabicCountryName } from './country-code-resolve-arabic';

/** MCP-only data. The dashboard keeps its smaller English resolver. */
export function normalizeLocalizedCountryToken(raw: string): string {
  return raw.normalize('NFKC').toLowerCase()
    .normalize('NFD')
    .replace(/(?<=[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu, '')
    .normalize('NFC')
    .replace(/[\p{P}\p{Z}\s]+/gu, ' ')
    .trim();
}

const NAME_TO_ISO2 = new Map<string, string | null>();
function addName(name: string, code: string): void {
  const key = normalizeLocalizedCountryToken(name);
  if (!key) return;
  const previous = NAME_TO_ISO2.get(key);
  NAME_TO_ISO2.set(key, previous === undefined || previous === code ? code : null);
}

for (const names of Object.values(COUNTRY_NAMES.locales)) {
  for (const [code, aliases] of Object.entries(names)) {
    for (const name of aliases) addName(name, code);
  }
}
for (const [name, code] of Object.entries(ENGLISH_NAMES)) addName(name, code);

function resolveName(raw: string): string | null {
  // Localized abbreviations can be another country's ISO code, such as Spanish RU for GB.
  if (/^[a-z]{2,3}$/i.test(raw)) {
    const code = resolveCountryCode(raw);
    if (code) return code;
  }
  const key = normalizeLocalizedCountryToken(raw);
  if (NAME_TO_ISO2.has(key)) return NAME_TO_ISO2.get(key) ?? null;
  return resolveArabicCountryName(raw) ?? resolveCountryCode(raw);
}

/** Resolve one country without guessing which locale the caller used. */
export function resolveCountryArg(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return null;
  if (!/[()]/.test(trimmed)) return resolveName(trimmed);

  const key = normalizeLocalizedCountryToken(trimmed);
  if (NAME_TO_ISO2.has(key)) return NAME_TO_ISO2.get(key) ?? null;
  const parenthetical = trimmed.match(/^([^()]*)\(([^()]+)\)$/);
  if (!parenthetical) return null;
  const base = parenthetical[1]!.trim();
  const inner = parenthetical[2]!.trim();
  if (!base || !inner) return null;
  const fromBase = resolveName(base);
  const fromInner = resolveName(inner);
  if (fromBase && fromInner) return fromBase === fromInner ? fromBase : null;

  // A modifier may be part of the name, as in "Sudan (South)".
  const candidates = new Set<string>();
  const words = base.split(/\s+/);
  for (let at = 0; at <= words.length; at++) {
    const combined = [...words.slice(0, at), inner, ...words.slice(at)].join(' ');
    const combinedKey = normalizeLocalizedCountryToken(combined);
    const hit = NAME_TO_ISO2.get(combinedKey);
    if (hit) candidates.add(hit);
    const arabic = resolveArabicCountryName(combined);
    if (arabic) candidates.add(arabic);
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}
