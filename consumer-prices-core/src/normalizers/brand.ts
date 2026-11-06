import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLEANED_RE = /[^\w\s]/g;
const WHITESPACE_RE = /\s+/g;
const TITLE_CASE_RE = /\b\w/g;


interface BrandAliases {
  aliases: Record<string, string[]>;
}

let _aliases: Map<string, string> | null = null;

function loadAliases(): Map<string, string> {
  if (_aliases) return _aliases;

  const filePath = join(dirname(fileURLToPath(import.meta.url)), '../../../configs/brands/aliases.json');
  const map = new Map<string, string>();

  if (existsSync(filePath)) {
    const data = JSON.parse(readFileSync(filePath, 'utf8')) as BrandAliases;
    for (const [canonical, variants] of Object.entries(data.aliases)) {
      for (const v of variants) {
        map.set(v.toLowerCase(), canonical);
      }
    }
  }

  _aliases = map;
  return map;
}

export function normalizeBrand(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(CLEANED_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim();

  const aliases = loadAliases();
  return aliases.get(cleaned) ?? titleCase(cleaned);
}

function titleCase(s: string): string {
  return s.replace(TITLE_CASE_RE, (c) => c.toUpperCase());
}
