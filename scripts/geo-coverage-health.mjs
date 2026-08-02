#!/usr/bin/env node
/**
 * Geographic coverage health audit (#5957, epic #5948).
 *
 * Compares the strategic keyCountries declared in shared/geography.js against
 * the feed catalog (src/config/feeds.ts FULL_FEEDS + INTEL_SOURCES) using the
 * curated source→country map in shared/source-geography.json, and enforces
 * the policy in shared/geo-coverage-policy.json:
 *
 *   - strategic floors: min EN default-on local sources per keyCountry
 *   - zeroDefaultOnAllowlist: exact set of keyCountries allowed to have zero
 *     default-on local sources (fails both on undocumented gaps and on stale
 *     allowlist entries once coverage lands)
 *
 * Shared by tests/geo-coverage-health.test.mts (CI gate) and
 * scripts/geo-coverage-report.mjs (human-readable ops/product report).
 *
 * Loading note: feeds.ts pulls `rssProxyUrl` → `import.meta.env.DEV`, and Node
 * has no Vite env object, so we esbuild-bundle with defines + a stubbed
 * `@/utils` barrel — the same pattern as tests/feed-catalog-drift.test.mts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(SCRIPT_DIR, '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Strip reserved meta keys (e.g. `_readme`) from a shared JSON document. */
function dataEntries(doc, fileLabel) {
  const entries = Object.entries(doc).filter(([key]) => !key.startsWith('_'));
  if (entries.length === 0) throw new Error(`${fileLabel} has no data entries`);
  return entries;
}

/**
 * Bundle src/config/feeds.ts into a temp dir and import it.
 * Returns { feeds, cleanup } — caller MUST run cleanup() when done.
 */
async function bundleFeedsModule(repoRoot) {
  const tempDir = mkdtempSync(join(tmpdir(), 'geo-coverage-health-'));
  const outfile = join(tempDir, 'feeds-bundle.mjs');
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(tempDir, { recursive: true, force: true });
  };
  // Stub the @/utils barrel so we don't drag proxy → i18n → import.meta.glob.
  // feeds.ts only needs rssProxyUrl, and identity is fine for name registries.
  const stubUtilsPlugin = {
    name: 'stub-utils-barrel',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@\/utils$/ }, () => ({
        path: 'stub-utils',
        namespace: 'stub',
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export function rssProxyUrl(url) { return url; }\n',
        loader: 'js',
      }));
    },
  };
  try {
    const result = await build({
      entryPoints: [join(repoRoot, 'src/config/feeds.ts')],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      write: false,
      absWorkingDir: repoRoot,
      alias: { '@': join(repoRoot, 'src') },
      plugins: [stubUtilsPlugin],
      define: {
        'import.meta.env': JSON.stringify({
          DEV: false,
          PROD: true,
          SSR: false,
          MODE: 'test',
          BASE_URL: '/',
          VITE_VARIANT: 'full',
          VITE_RSS_DIRECT_TO_RELAY: 'false',
        }),
      },
    });
    writeFileSync(outfile, result.outputFiles[0].text, 'utf8');
    const feeds = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    return { feeds, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Return the default-enabled catalog sources that are reachable for EN. */
export function getEnglishDefaultEnabledSources(feeds) {
  const defaultEnabled = feeds.getAllDefaultEnabledSources();
  const allFeeds = [
    ...Object.values(feeds.FULL_FEEDS).flat(),
    ...feeds.INTEL_SOURCES,
  ];
  return new Set(
    allFeeds
      .filter((feed) => defaultEnabled.has(feed.name) && (!feed.lang || feed.lang === 'en'))
      .map((feed) => feed.name),
  );
}

/**
 * Load every input the audit needs.
 * @param {string} [repoRoot]
 */
export async function loadGeoCoverageInputs(repoRoot = DEFAULT_REPO_ROOT) {
  const [{ REGIONS }, sourceGeographyDoc, policy, iso2ToRegion] = await Promise.all([
    import(pathToFileURL(join(repoRoot, 'shared/geography.js')).href),
    readJson(join(repoRoot, 'shared/source-geography.json')),
    readJson(join(repoRoot, 'shared/geo-coverage-policy.json')),
    readJson(join(repoRoot, 'shared/iso2-to-region.json')),
  ]);
  const { feeds, cleanup } = await bundleFeedsModule(repoRoot);

  // Deduped keyCountries → owning display regions ('global' repeats strategic
  // countries and is not itself a coverage area, so it is not listed as an owner).
  /** @type {Map<string, string[]>} */
  const byIso = new Map();
  for (const region of REGIONS) {
    if (region.id === 'global') continue;
    for (const iso2 of region.keyCountries) {
      const owners = byIso.get(iso2) ?? [];
      owners.push(region.id);
      byIso.set(iso2, owners);
    }
  }
  const keyCountries = [...byIso.entries()].map(([iso2, regions]) => ({ iso2, regions }));

  const sourceGeography = new Map(
    dataEntries(sourceGeographyDoc, 'source-geography.json').map(([name, countries]) => {
      if (!Array.isArray(countries) || countries.length === 0) {
        throw new Error(`source-geography.json: "${name}" must map to a non-empty ISO2 array`);
      }
      return [name, countries];
    }),
  );

  const catalogNames = new Set([
    ...Object.values(feeds.FULL_FEEDS).flat().map((f) => f.name),
    ...feeds.INTEL_SOURCES.map((f) => f.name),
  ]);
  const defaultEnabled = getEnglishDefaultEnabledSources(feeds);
  const validIso2 = new Set([...Object.keys(iso2ToRegion), ...byIso.keys()]);

  return {
    keyCountries,
    regions: REGIONS.filter((r) => r.id !== 'global'),
    sourceGeography,
    policy,
    catalogNames,
    defaultEnabled,
    validIso2,
    catalogSize: catalogNames.size,
    defaultEnabledSize: defaultEnabled.size,
    cleanup,
  };
}

/**
 * Structural integrity of the curated map against the catalog and geography.
 * Returns a list of problems (empty = clean).
 */
export function validateSourceGeography({ sourceGeography, catalogNames, validIso2 }) {
  const problems = [];
  for (const [name, countries] of sourceGeography) {
    if (!catalogNames.has(name)) {
      problems.push(
        `source-geography.json: "${name}" is not a configured feed source ` +
        '(rename in src/config/feeds.ts or fix the map)',
      );
    }
    for (const iso2 of countries) {
      if (!validIso2.has(iso2)) {
        problems.push(`source-geography.json: "${name}" tags unknown ISO2 "${iso2}"`);
      }
    }
  }
  return problems;
}

/** Structural integrity of policy keys against the deduped keyCountry set. */
export function validateGeoCoveragePolicy({ policy, keyCountries }) {
  const known = new Set(keyCountries.map(({ iso2 }) => iso2));
  const problems = [];
  for (const [section, values] of [
    ['floors', policy.floors ?? {}],
    ['zeroDefaultOnAllowlist', policy.zeroDefaultOnAllowlist ?? {}],
  ]) {
    for (const iso2 of Object.keys(values)) {
      if (!known.has(iso2)) {
        problems.push(
          `geo-coverage-policy.json: ${section} key "${iso2}" is not a keyCountry in shared/geography.js`,
        );
      }
    }
  }
  return problems;
}

/**
 * Per-keyCountry coverage rows.
 * Row: { iso2, regions, catalogSources, defaultOnSources, floor, allowlistReason }
 */
export function computeGeoCoverage({ keyCountries, sourceGeography, defaultEnabled, policy }) {
  const localByIso = new Map();
  for (const [name, countries] of sourceGeography) {
    for (const iso2 of countries) {
      const names = localByIso.get(iso2) ?? [];
      names.push(name);
      localByIso.set(iso2, names);
    }
  }
  return keyCountries.map(({ iso2, regions }) => {
    const catalogSources = (localByIso.get(iso2) ?? []).sort((a, b) => a.localeCompare(b));
    const defaultOnSources = catalogSources.filter((name) => defaultEnabled.has(name));
    return {
      iso2,
      regions,
      catalogSources,
      defaultOnSources,
      floor: policy.floors[iso2] ?? 0,
      allowlistReason: policy.zeroDefaultOnAllowlist[iso2] ?? null,
    };
  });
}

/**
 * Policy evaluation. Returns { violations, rows } where each row gains a
 * `status`: OK | ALLOWLISTED | FLOOR-BREACH | GAP-UNDOCUMENTED | ALLOWLIST-STALE.
 */
export function evaluateGeoCoverage(rows) {
  const violations = [];
  for (const row of rows) {
    const onCount = row.defaultOnSources.length;
    if (onCount < row.floor) {
      row.status = 'FLOOR-BREACH';
      violations.push(
        `${row.iso2}: ${onCount} default-on local source(s), below floor ${row.floor} — ` +
        'restore coverage or lower the floor in shared/geo-coverage-policy.json with a documented reason',
      );
    } else if (onCount === 0 && !row.allowlistReason) {
      row.status = 'GAP-UNDOCUMENTED';
      violations.push(
        `${row.iso2}: zero default-on local sources and no allowlist entry — ` +
        'add local coverage or document the exception in shared/geo-coverage-policy.json',
      );
    } else if (onCount > 0 && row.allowlistReason) {
      row.status = 'ALLOWLIST-STALE';
      violations.push(
        `${row.iso2}: now has ${onCount} default-on local source(s) — ` +
        'remove the stale entry from zeroDefaultOnAllowlist in shared/geo-coverage-policy.json',
      );
    } else {
      row.status = onCount === 0 ? 'ALLOWLISTED' : 'OK';
    }
  }
  return { violations, rows };
}

/** Human-readable report for ops/product reviews. */
export function formatGeoCoverageHuman({ rows, regions, violations, catalogSize, defaultEnabledSize, policy }) {
  const lines = [];
  lines.push('Geographic coverage health — keyCountries vs feed catalog');
  lines.push(`Catalog: ${catalogSize} sources (full variant + intel), ${defaultEnabledSize} default-on (EN)`);
  lines.push(`Floors: ${Object.entries(policy.floors).map(([iso, n]) => `${iso}≥${n}`).join(' ') || '(none)'}`);
  lines.push('');
  const byIso = new Map(rows.map((row) => [row.iso2, row]));
  for (const region of regions) {
    lines.push(`${region.id} — ${region.label}`);
    for (const iso2 of region.keyCountries) {
      const row = byIso.get(iso2);
      if (!row) continue;
      const floor = row.floor > 0 ? `floor=${row.floor}` : 'floor=-';
      const status = row.status.padEnd(17);
      const sources = row.catalogSources.length === 0
        ? '(no local sources in catalog)'
        : row.catalogSources
            .map((name) => (row.defaultOnSources.includes(name) ? `${name} *` : name))
            .join(', ');
      lines.push(
        `  ${iso2.padEnd(4)} catalog=${String(row.catalogSources.length).padEnd(3)}` +
        ` default-on=${String(row.defaultOnSources.length).padEnd(3)} ${floor.padEnd(8)} ${status} ${sources}`,
      );
      if (row.status === 'ALLOWLISTED') {
        lines.push(`       ↳ allowlisted: ${row.allowlistReason}`);
      }
    }
    lines.push('');
  }
  lines.push('* = default-on (EN). Floors and the zero-default-on allowlist live in shared/geo-coverage-policy.json.');
  lines.push('');
  if (violations.length > 0) {
    lines.push(`VIOLATIONS (${violations.length}):`);
    for (const v of violations) lines.push(`  - ${v}`);
  } else {
    lines.push('Violations: 0 — all floors hold, allowlist matches reality.');
  }
  return lines.join('\n');
}
