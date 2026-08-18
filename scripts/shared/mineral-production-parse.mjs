#!/usr/bin/env node
/**
 * Pure USGS MCS / BGS parsers for mineral production shares.
 * No I/O. Used by seed-mineral-production.mjs and unit tests.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { countryNameToIso2 } = require('./country-name-to-iso2.cjs');

function normalizeCountryToken(raw) {
  return String(raw || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[''‘’`.(),/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HERE = dirname(fileURLToPath(import.meta.url));

export const CANONICAL_KEY = 'supply-chain:mineral-production:v1';
export const SCHEMA_VERSION = 1;

export function loadMineralVocab() {
  return JSON.parse(readFileSync(join(HERE, 'mineral-commodities.json'), 'utf8'));
}

export function loadMineralCountryAliases() {
  return JSON.parse(readFileSync(join(HERE, 'mineral-country-aliases.json'), 'utf8'));
}

export function parseUsgsValue(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { kind: 'empty' };
  if (text === 'W' || text === 'w') return { kind: 'withheld' };
  if (text === 'NA' || text === 'N/A' || text === 'na') return { kind: 'na' };
  if (text === 'E') return { kind: 'unquantified' };
  if (text === 's' || text === 'S') return { kind: 'unquantified' };
  if (text === '—' || text === '–' || text === '-' || text === '\u2014' || text === '\u2013' || text === '\u0097') {
    return { kind: 'nil' };
  }
  const n = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(n)) return { kind: 'unparsed', raw: text };
  return { kind: 'number', value: n };
}

export function isUsgsWorldTotalDetail(detail) {
  return /:\s*rounded\s*$/i.test(String(detail || ''));
}

export function classifyUsgsStage(section, detail) {
  const s = String(section || '').toLowerCase();
  const d = String(detail || '').replace(/:\s*rounded\s*$/i, '').toLowerCase();
  if (d.includes('refinery') || d.includes('smelter') || d.includes('alumina, refinery')) return 'refinery';
  if (d.includes('primary production')) return 'refinery';
  if (d.includes('mine') || d.includes('bauxite, mine') || d.includes('helium production')) return 'mine';
  if (d === 'production' || d.startsWith('production,')) {
    if (s.includes('refinery') && !s.includes('mine')) return 'refinery';
    if (s.includes('smelter')) return 'refinery';
    if (s.startsWith('world')) return 'mine';
  }
  if (s.includes('refinery') && !s.includes('mine')) return 'refinery';
  if (s.includes('smelter')) return 'refinery';
  if (s.includes('mine production')) return 'mine';
  if (s.startsWith('world production')) return 'mine';
  return null;
}

export function resolveMineralCountry(rawName, aliases = loadMineralCountryAliases()) {
  const name = String(rawName || '').trim();
  if (!name) return { iso2: null, residual: false, unmapped: true, name };
  if (/^other countries$/i.test(name)) {
    return { iso2: '', residual: true, unmapped: false, name: 'Other countries' };
  }
  if (/^world total$/i.test(name)) {
    return { iso2: null, residual: false, unmapped: false, worldTotal: true, name };
  }
  const token = normalizeCountryToken(name);
  const aliasHit = aliases[token] || aliases[name.toLowerCase()];
  if (aliasHit) return { iso2: aliasHit, residual: false, unmapped: false, name };
  const mapped = countryNameToIso2(name);
  if (mapped) return { iso2: mapped, residual: false, unmapped: false, name };
  return { iso2: null, residual: false, unmapped: true, name };
}

function indexVocab(vocab) {
  const byUsgsName = new Map();
  const byChapter = new Map();
  const byBgsName = new Map();
  for (const item of vocab.commodities) {
    for (const n of item.usgsNames || []) byUsgsName.set(n.toLowerCase(), item);
    for (const n of item.usgsChapters || []) {
      const key = n.toLowerCase();
      // A chapter claimed by two commodities (e.g. "BAUXITE AND ALUMINA") would
      // otherwise resolve to whichever entry was registered last, silently
      // attributing one commodity's rows to the other. Fail loudly instead.
      const claimed = byChapter.get(key);
      if (claimed && claimed.id !== item.id) {
        throw new Error(
          `mineral-commodities.json: usgsChapters key "${n}" is claimed by both `
          + `"${claimed.id}" and "${item.id}"; a chapter must map to one commodity`,
        );
      }
      byChapter.set(key, item);
    }
    for (const n of item.bgsNames || []) byBgsName.set(n.toLowerCase(), item);
  }
  return { byUsgsName, byChapter, byBgsName };
}

export function decodeUsgsCsvText(bufOrText) {
  if (typeof bufOrText === 'string') return bufOrText;
  const buf = Buffer.isBuffer(bufOrText) ? bufOrText : Buffer.from(bufOrText);
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD') && !/[\x80-\x9F]/.test(utf8.slice(0, 4000))) return utf8;
  return buf.toString('latin1');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    if (row.length === 1 && row[0] === '') { row = []; return; }
    rows.push(row);
    row = [];
  };
  const src = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      if (field.endsWith('\r')) field = field.slice(0, -1);
      pushField();
      pushRow();
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    pushField();
    pushRow();
  }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map((cells) => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = cells[i] ?? '';
    return obj;
  });
}

export function parseUsgsMcsCsv(text, { vocab = loadMineralVocab(), aliases = loadMineralCountryAliases() } = {}) {
  const index = indexVocab(vocab);
  const records = parseCsv(decodeUsgsCsvText(text));
  const unmapped = [];
  const rows = [];
  for (const rec of records) {
    const commodityName = rec.Commodity || rec.commodity || '';
    const chapter = rec['MCS chapter'] || rec.Chapter || '';
    const item = index.byUsgsName.get(commodityName.toLowerCase())
      || index.byChapter.get(chapter.toLowerCase());
    if (!item) continue;
    const section = rec.Section || '';
    if (!/^world\b/i.test(section)) continue;
    const statistics = rec.Statistics || '';
    if (statistics && statistics !== 'Production') continue;
    const detail = rec.Statistics_detail || '';
    const stage = classifyUsgsStage(section, detail);
    if (!stage) continue;
    const year = Number(rec.Year);
    if (!Number.isInteger(year)) continue;
    const parsed = parseUsgsValue(rec.Value);
    const countryRaw = rec.Country || '';
    const resolved = resolveMineralCountry(countryRaw, aliases);
    if (resolved.unmapped) unmapped.push({ country: countryRaw, commodity: item.id });
    const estimated = /\bestimated\b/i.test(rec.Notes || '');
    const worldTotal = Boolean(resolved.worldTotal) || isUsgsWorldTotalDetail(detail);
    rows.push({
      commodityId: item.id,
      commodityLabel: item.label,
      stage,
      year,
      unit: rec.Unit || '',
      country: resolved.name,
      iso2: resolved.iso2,
      residual: Boolean(resolved.residual),
      worldTotal,
      withheld: parsed.kind === 'withheld',
      estimated,
      output: parsed.kind === 'number' ? parsed.value : null,
      valueKind: parsed.kind,
      source: 'usgs-mcs',
    });
  }
  return { rows, unmapped };
}

function classifyBgsStage(subCommodity, statisticType) {
  const blob = `${subCommodity || ''} ${statisticType || ''}`.toLowerCase();
  if (blob.includes('refin') || blob.includes('smelter') || blob.includes('alumina')) return 'refinery';
  if (blob.includes('mine') || blob.includes('production')) return 'mine';
  return 'mine';
}

export function parseBgsRecords(records, { vocab = loadMineralVocab(), aliases = loadMineralCountryAliases() } = {}) {
  const index = indexVocab(vocab);
  const unmapped = [];
  const rows = [];
  for (const rec of records || []) {
    const name = rec.commodity || rec.Commodity || '';
    const sub = rec.sub_commodity || rec.subCommodity || '';
    const item = index.byBgsName.get(String(name).toLowerCase())
      || index.byBgsName.get(String(sub).toLowerCase());
    if (!item) continue;
    const statistic = rec.statistic_type || rec.statisticType || rec.Statistics || 'Production';
    if (statistic && !/production/i.test(String(statistic))) continue;
    const year = Number(rec.year || rec.Year);
    if (!Number.isInteger(year)) continue;
    const rawVal = rec.value ?? rec.Value;
    const parsed = typeof rawVal === 'number'
      ? (Number.isFinite(rawVal) ? { kind: 'number', value: rawVal } : { kind: 'empty' })
      : parseUsgsValue(rawVal);
    const countryRaw = rec.country || rec.Country || '';
    const resolved = resolveMineralCountry(countryRaw, aliases);
    if (resolved.unmapped) unmapped.push({ country: countryRaw, commodity: item.id });
    if (resolved.worldTotal) continue;
    rows.push({
      commodityId: item.id,
      commodityLabel: item.label,
      stage: classifyBgsStage(sub, statistic),
      year,
      unit: rec.unit || rec.Unit || '',
      country: resolved.name,
      iso2: resolved.iso2,
      residual: Boolean(resolved.residual),
      worldTotal: false,
      withheld: parsed.kind === 'withheld',
      estimated: false,
      output: parsed.kind === 'number' ? parsed.value : null,
      valueKind: parsed.kind,
      source: 'bgs',
    });
  }
  return { rows, unmapped };
}

export function computeHhiFromShares(sharesPct) {
  if (!sharesPct.length) return 0;
  return sharesPct.reduce((sum, s) => sum + s * s, 0);
}

function pickYear(rows, preferredYear) {
  if (preferredYear) {
    const hit = rows.filter((r) => r.year === preferredYear);
    if (hit.length) return preferredYear;
  }
  const years = [...new Set(rows.filter((r) => r.output != null || r.withheld).map((r) => r.year))];
  return years.length ? Math.max(...years) : null;
}

export function aggregateMineralProduction(rows, { preferredYear = null, vocab = loadMineralVocab() } = {}) {
  const byCommodity = new Map();
  for (const row of rows) {
    if (!byCommodity.has(row.commodityId)) byCommodity.set(row.commodityId, []);
    byCommodity.get(row.commodityId).push(row);
  }

  const commodities = {};
  for (const item of vocab.commodities) {
    const all = byCommodity.get(item.id) || [];
    const stages = {};
    for (const stage of ['mine', 'refinery']) {
      const usable = all.filter((r) => r.stage === stage);
      const year = pickYear(usable.filter((r) => !r.worldTotal), preferredYear);
      if (year == null) {
        stages[stage] = null;
        continue;
      }
      const yearRows = usable.filter((r) => r.year === year);
      const worldTotalRow = yearRows.find((r) => r.worldTotal && r.output != null);
      const countries = [];
      const unmapped = [];
      let quantified = 0;
      let withheldCount = 0;
      const unit = yearRows.find((r) => r.unit)?.unit || '';
      for (const r of yearRows) {
        if (r.worldTotal) continue;
        if (r.withheld) {
          withheldCount += 1;
          countries.push({
            iso2: r.iso2 || '',
            country: r.country,
            output: null,
            share: null,
            withheld: true,
            estimated: r.estimated,
            residual: Boolean(r.residual),
          });
          continue;
        }
        if (r.output == null) continue;
        quantified += r.output;
        countries.push({
          iso2: r.iso2 || '',
          country: r.country,
          output: r.output,
          share: null,
          withheld: false,
          estimated: r.estimated,
          residual: Boolean(r.residual),
        });
        if (!r.iso2 && !r.residual) unmapped.push(r.country);
      }
      const denom = quantified > 0 ? quantified : null;
      for (const c of countries) {
        if (c.withheld || denom == null || c.output == null) continue;
        c.share = (c.output / denom) * 100;
      }
      countries.sort((a, b) => {
        if (a.withheld !== b.withheld) return a.withheld ? 1 : -1;
        return (b.output ?? -1) - (a.output ?? -1);
      });
      // The USGS "Other countries" residual is an aggregate of many small
      // producers, not a firm. Squaring it as if it were one would bias HHI
      // upward by exactly residual^2 (copper mine: 170 of 1206 points from a
      // 13.0% residual). Exclude it so the index is a lower bound over named
      // producers rather than an inflated value that can cross a 1500/2500 band.
      const hhi = computeHhiFromShares(
        countries.filter((c) => c.share != null && !c.residual).map((c) => c.share),
      );
      stages[stage] = {
        year,
        unit,
        countries,
        hhi,
        worldTotal: worldTotalRow?.output ?? quantified,
        withheldCount,
        unmappedCount: unmapped.length,
      };
    }
    const sources = [...new Set(all.map((r) => r.source))];
    const year = stages.mine?.year ?? stages.refinery?.year ?? null;
    const unit = stages.mine?.unit || stages.refinery?.unit || '';
    if (!stages.mine && !stages.refinery) continue;
    commodities[item.id] = {
      id: item.id,
      label: item.label,
      year,
      unit,
      stages: {
        mine: stages.mine,
        refinery: stages.refinery,
      },
      sources,
      mcsGap: item.mcsGap || null,
    };
  }

  return commodities;
}

export function buildMineralProductionPayload(rows, opts = {}) {
  const commodities = aggregateMineralProduction(rows, opts);
  const unmapped = [];
  for (const row of rows) {
    // Rows are only ever built by parseUsgsMcsCsv/parseBgsRecords, which never
    // set `.unmapped` and only ever emit stage 'mine' | 'refinery' -- the two
    // extra clauses this condition used to carry could not fire.
    if (row.iso2 == null && !row.residual && !row.worldTotal) {
      if (row.country) unmapped.push({ country: row.country, commodity: row.commodityId });
    }
  }
  const dataYears = Object.values(commodities)
    .map((c) => c.year)
    .filter((y) => Number.isInteger(y));
  return {
    fetchedAt: opts.fetchedAt || new Date().toISOString(),
    edition: opts.edition || null,
    dataYear: dataYears.length ? Math.max(...dataYears) : null,
    commodities,
    unmappedCount: unmapped.length,
    unmappedSample: unmapped.slice(0, 20),
    sources: opts.sources || ['usgs-mcs'],
    ieaSkipped: true,
    ieaSkipReason: 'IEA redistribution terms are stricter than USGS/BGS; REE refining shares that USGS does not publish are omitted.',
  };
}

export function mergeUsgsThenBgs(usgsRows, bgsRows) {
  const have = new Set();
  for (const row of usgsRows) {
    if (row.stage === 'mine' || row.stage === 'refinery') {
      have.add(`${row.commodityId}:${row.stage}`);
    }
  }
  const fill = bgsRows.filter((row) => !have.has(`${row.commodityId}:${row.stage}`));
  return [...usgsRows, ...fill];
}
