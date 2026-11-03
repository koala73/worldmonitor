export interface SanctionsIndexRecord {
  id: string;
  name: string;
  et: string;
  cc: string[];
  pr: string[];
  al?: string[];
  ids?: string[];
  sl?: string[];
}

export interface SanctionsScreenMatch extends SanctionsIndexRecord {
  score: number;
  matched_on: 'name' | 'alias' | 'identifier';
  matched_text: string;
}

const LEGAL_SUFFIX = /(?:\s|^)(?:llc|ltd|limited|inc|incorporated|corp|corporation|co|company|plc|gmbh|ag|sa|sarl|ooo|ao)$/u;

export function normalizeSanctionsName(value: string): string {
  let name = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\b(?:[a-z]\.){2,}/g, word => word.replace(/\./g, ''))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  while (LEGAL_SUFFIX.test(name)) name = name.replace(LEGAL_SUFFIX, '').trim();
  return name;
}

export function sanctionsIndexRecords(raw: unknown): SanctionsIndexRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is SanctionsIndexRecord => row !== null && typeof row === 'object'
    && ['id', 'name', 'et'].every(key => typeof row[key] === 'string')
    && ['cc', 'pr'].every(key => Array.isArray(row[key]) && row[key].every((v: unknown) => typeof v === 'string'))
    && ['al', 'ids', 'sl'].every(key => row[key] === undefined
      || Array.isArray(row[key]) && row[key].every((v: unknown) => typeof v === 'string')));
}

function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const radius = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - radius); j < Math.min(b.length, i + radius + 1); j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  const aSequence = a.split('').filter((_, i) => aMatched[i]);
  const bSequence = b.split('').filter((_, i) => bMatched[i]);
  const transpositions = aSequence.filter((c, i) => c !== bSequence[i]).length / 2;
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro > 0.7 ? jaro + prefix * 0.1 * (1 - jaro) : jaro;
}

function tokenSetScore(a: string, b: string): number {
  if (!a || !b) return 0;
  const left = new Set(a.split(' '));
  const right = new Set(b.split(' '));
  const rightTokens = [...right];
  if (![...left].every(token => rightTokens.some(candidate => jaroWinkler(token, candidate) >= 0.8))) return 0;
  const shared = [...left].filter(token => right.has(token)).sort();
  const joined = (tokens: string[]) => tokens.join(' ');
  const leftText = joined([...shared, ...[...left].filter(token => !right.has(token)).sort()]);
  const rightText = joined([...shared, ...[...right].filter(token => !left.has(token)).sort()]);
  const common = joined(shared);
  return Math.round(100 * Math.max(jaroWinkler(leftText, rightText),
    common ? jaroWinkler(common, leftText) : 0, common ? jaroWinkler(common, rightText) : 0));
}

export function screenSanctions(raw: unknown, query: string, minScore = 70): SanctionsScreenMatch[] {
  const identifier = /^(?:imo[\s:-]*)?(\d{7})$/i.exec(query.trim());
  const needle = normalizeSanctionsName(query);
  if (!needle) return [];
  const matches: SanctionsScreenMatch[] = [];
  for (const entry of sanctionsIndexRecords(raw)) {
    if (identifier) {
      const id = (entry.ids ?? []).find(value => value === `imo:${identifier[1]}`);
      if (id) matches.push({ ...entry, score: 100, matched_on: 'identifier', matched_text: id });
      continue;
    }
    let score = tokenSetScore(needle, normalizeSanctionsName(entry.name));
    let exact = needle === normalizeSanctionsName(entry.name);
    let matched_on: SanctionsScreenMatch['matched_on'] = 'name';
    let matched_text = entry.name;
    for (const alias of entry.al ?? []) {
      const normalized = normalizeSanctionsName(alias);
      const aliasScore = tokenSetScore(needle, normalized);
      if (aliasScore > score || aliasScore === score && normalized === needle && !exact) {
        score = aliasScore;
        exact = normalized === needle;
        matched_on = 'alias';
        matched_text = alias;
      }
    }
    if (score >= minScore) matches.push({ ...entry, score, matched_on, matched_text });
  }
  return matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
