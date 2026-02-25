/**
 * Shared BIS (Bank for International Settlements) CSV fetch + parse helpers.
 * Used by all 3 BIS RPC handlers.
 */

import { CHROME_UA } from '../../../_shared/constants';
import Papa from 'papaparse';

const BIS_BASE = 'https://stats.bis.org/api/v1/data';

// Curated BIS country codes — aligned with CENTRAL_BANKS in finance-geo.ts
// BIS uses ISO 2-letter codes except XM for Euro Area (maps from DE in finance-geo)
export const BIS_COUNTRIES: Record<string, { name: string; centralBank: string }> = {
  US: { name: 'United States', centralBank: 'Federal Reserve' },
  GB: { name: 'United Kingdom', centralBank: 'Bank of England' },
  JP: { name: 'Japan', centralBank: 'Bank of Japan' },
  XM: { name: 'Euro Area', centralBank: 'ECB' },
  CH: { name: 'Switzerland', centralBank: 'Swiss National Bank' },
  SG: { name: 'Singapore', centralBank: 'MAS' },
  IN: { name: 'India', centralBank: 'Reserve Bank of India' },
  AU: { name: 'Australia', centralBank: 'RBA' },
  CN: { name: 'China', centralBank: "People's Bank of China" },
  CA: { name: 'Canada', centralBank: 'Bank of Canada' },
  KR: { name: 'South Korea', centralBank: 'Bank of Korea' },
  BR: { name: 'Brazil', centralBank: 'Banco Central do Brasil' },
};

export const BIS_COUNTRY_KEYS = Object.keys(BIS_COUNTRIES).join('+');

export async function fetchBisCSV(dataset: string, key: string, timeout = 12000): Promise<string> {
  const separator = key.includes('?') ? '&' : '?';
  const url = `${BIS_BASE}/${dataset}/${key}${separator}format=csv`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`BIS HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(id);
  }
}

// Parse BIS CSV using papaparse — robust handling of quoted fields & metadata
export function parseBisCSV(csv: string): Array<Record<string, string>> {
  const result = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false, // keep as strings, parse numbers explicitly
  });
  if (result.errors.length > 0) {
    console.warn('[BIS] CSV parse errors:', result.errors.slice(0, 3));
    if (result.data.length === 0) return [];
  }
  return result.data;
}

// Safe numeric parse — BIS uses '.' or empty for missing values
export function parseBisNumber(val: string | undefined): number | null {
  if (!val || val === '.' || val.trim() === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}
