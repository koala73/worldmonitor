import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// Regression-verifies the frozen resilience-ranking snapshots under
// docs/snapshots/. Two shapes are supported:
//
//  1. "Published tables" shape (e.g. resilience-ranking-2026-04-21.json):
//     tables.topTen / tables.bottomTen / tables.majorEconomies curated rows.
//     This is the source of truth for any published ranking figures and
//     the assertions below pin its internal consistency.
//
//  2. "Live capture" shape (produced by scripts/freeze-resilience-ranking.mjs):
//     full items[] + greyedOut[] from the live API. Additional invariants
//     (monotonic, unique ranks, greyedOut coverage < 0.40) are asserted on
//     this shape.
//
// Any new snapshot committed to docs/snapshots/ is auto-discovered.

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'docs', 'snapshots');

// Band anchors from the release-gate tests (tests/resilience-release-gate.test.mts).
// Countries in the high-anchor set must never drop below 70 in a published
// snapshot; countries in the low-anchor set must never climb above 45.
const HIGH_BAND_ANCHORS = new Set(['NO', 'CH', 'DK', 'IS', 'FI', 'SE', 'NZ']);
const LOW_BAND_ANCHORS = new Set(['YE', 'SO', 'SD', 'CD']);
const HIGH_BAND_FLOOR = 70;
const LOW_BAND_CEILING = 45;

interface PublishedRow {
  rank: number;
  countryCode: string;
  countryName: string;
  overallScore: number;
  dimensionCoverage: number;
}

interface LiveItem {
  rank: number;
  countryCode: string;
  countryName?: string;
  overallScore: number;
  overallScoreRaw?: number;
  dimensionCoverage?: number;
  lowConfidence?: boolean;
}

interface SnapshotPublished {
  capturedAt: string;
  commitSha: string;
  schemaVersion: string;
  methodology: {
    domainCount: number;
    dimensionCount: number;
    pillarCount: number;
    greyOutThreshold: number;
  };
  tables: {
    topTen: PublishedRow[];
    bottomTen: PublishedRow[];
    majorEconomies: PublishedRow[];
  };
  totals: { rankedCountries: number };
}

interface SnapshotLive {
  capturedAt: string;
  commitSha: string;
  schemaVersion: string;
  methodology: {
    domainCount: number;
    dimensionCount: number;
    pillarCount: number;
    greyOutThreshold: number;
  };
  totals: { rankedCountries: number; greyedOutCount: number };
  items: LiveItem[];
  greyedOut: Array<{ countryCode: string; overallCoverage: number }>;
}

type Snapshot = SnapshotPublished | SnapshotLive;

function isLive(snapshot: Snapshot): snapshot is SnapshotLive {
  return Array.isArray((snapshot as SnapshotLive).items);
}

function isPublished(snapshot: Snapshot): snapshot is SnapshotPublished {
  return (snapshot as SnapshotPublished).tables != null;
}

function loadSnapshots(): { filename: string; snapshot: Snapshot }[] {
  let entries: string[];
  try {
    entries = readdirSync(SNAPSHOT_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^resilience-ranking-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .map((filename) => ({
      filename,
      snapshot: JSON.parse(readFileSync(path.join(SNAPSHOT_DIR, filename), 'utf8')) as Snapshot,
    }));
}

const SNAPSHOTS = loadSnapshots();

describe('resilience-ranking snapshots', () => {
  it('snapshot directory contains at least one frozen artifact', () => {
    assert.ok(
      SNAPSHOTS.length >= 1,
      `expected at least one resilience-ranking-YYYY-MM-DD.json under docs/snapshots/, got 0. Run scripts/freeze-resilience-ranking.mjs against the live API to refresh.`,
    );
  });

  for (const { filename, snapshot } of SNAPSHOTS) {
    describe(filename, () => {
      it('capturedAt is a parseable ISO date', () => {
        assert.match(snapshot.capturedAt, /^\d{4}-\d{2}-\d{2}$/);
        const parsed = new Date(snapshot.capturedAt);
        assert.ok(!Number.isNaN(parsed.getTime()), `capturedAt=${snapshot.capturedAt} must parse to a real date`);
      });

      it('commit SHA is present (40-char hex or "unknown")', () => {
        assert.ok(
          /^[0-9a-f]{40}$/.test(snapshot.commitSha) || snapshot.commitSha === 'unknown',
          `commitSha=${snapshot.commitSha} must be a 40-char git SHA or "unknown"`,
        );
      });

      it('schemaVersion matches the production default', () => {
        // Flip this pin when the pillar-combined overall_score activates and
        // the schema contract changes; until then, 2.0 is the live shape.
        assert.equal(snapshot.schemaVersion, '2.0');
      });

      it('methodology pins the 6-domain / 19-dimension / 3-pillar shape', () => {
        assert.equal(snapshot.methodology.domainCount, 6);
        assert.equal(snapshot.methodology.dimensionCount, 19);
        assert.equal(snapshot.methodology.pillarCount, 3);
        assert.equal(snapshot.methodology.greyOutThreshold, 0.40);
      });

      if (isPublished(snapshot)) {
        it('published topTen ranks are 1..10, scores descend, all scores in (0,100)', () => {
          const rows = snapshot.tables.topTen;
          assert.equal(rows.length, 10);
          for (let i = 0; i < rows.length; i++) {
            assert.equal(rows[i]!.rank, i + 1, `topTen[${i}].rank should be ${i + 1}, got ${rows[i]!.rank}`);
            assert.ok(rows[i]!.overallScore > 0 && rows[i]!.overallScore < 100);
            if (i > 0) {
              assert.ok(
                rows[i]!.overallScore <= rows[i - 1]!.overallScore,
                `topTen must be monotonically non-increasing at rank ${rows[i]!.rank}: ${rows[i - 1]!.overallScore} → ${rows[i]!.overallScore}`,
              );
            }
          }
        });

        it('published bottomTen ranks are contiguous and climb monotonically in rank / descend in score', () => {
          const rows = snapshot.tables.bottomTen;
          assert.equal(rows.length, 10);
          for (let i = 1; i < rows.length; i++) {
            assert.equal(
              rows[i]!.rank,
              rows[i - 1]!.rank + 1,
              `bottomTen ranks must be contiguous: ${rows[i - 1]!.rank} then ${rows[i]!.rank}`,
            );
            assert.ok(
              rows[i]!.overallScore <= rows[i - 1]!.overallScore,
              `bottomTen scores must not increase with worsening rank: ${rows[i - 1]!.countryCode}=${rows[i - 1]!.overallScore} then ${rows[i]!.countryCode}=${rows[i]!.overallScore}`,
            );
          }
          // Last row's rank must equal the claimed ranked-country total.
          assert.equal(
            rows[rows.length - 1]!.rank,
            snapshot.totals.rankedCountries,
            `bottomTen.last.rank=${rows[rows.length - 1]!.rank} must equal totals.rankedCountries=${snapshot.totals.rankedCountries}`,
          );
        });

        it('country codes are distinct across all three tables', () => {
          const codes = [
            ...snapshot.tables.topTen,
            ...snapshot.tables.bottomTen,
            ...snapshot.tables.majorEconomies,
          ].map((row) => row.countryCode);
          const unique = new Set(codes);
          // Major economies can overlap topTen (e.g. if Japan is in both),
          // so only assert uniqueness within each table, not across.
          for (const table of ['topTen', 'bottomTen', 'majorEconomies'] as const) {
            const tableCodes = snapshot.tables[table].map((row) => row.countryCode);
            assert.equal(
              new Set(tableCodes).size,
              tableCodes.length,
              `${table} contains duplicate country codes`,
            );
          }
          // Sanity: at minimum the union has more entries than any single table.
          assert.ok(unique.size >= Math.max(snapshot.tables.topTen.length, snapshot.tables.bottomTen.length));
        });

        it('high-band anchors appearing in topTen stay above the release-gate floor', () => {
          for (const row of snapshot.tables.topTen) {
            if (!HIGH_BAND_ANCHORS.has(row.countryCode)) continue;
            assert.ok(
              row.overallScore >= HIGH_BAND_FLOOR,
              `${row.countryCode} (${row.countryName}) is a high-band anchor and must stay ≥${HIGH_BAND_FLOOR}, got ${row.overallScore}`,
            );
          }
        });

        it('low-band anchors appearing in bottomTen stay below the release-gate ceiling', () => {
          for (const row of snapshot.tables.bottomTen) {
            if (!LOW_BAND_ANCHORS.has(row.countryCode)) continue;
            assert.ok(
              row.overallScore <= LOW_BAND_CEILING,
              `${row.countryCode} (${row.countryName}) is a low-band anchor and must stay ≤${LOW_BAND_CEILING}, got ${row.overallScore}`,
            );
          }
        });

        it('every dimensionCoverage in published rows is in [0, 1]', () => {
          const all = [
            ...snapshot.tables.topTen,
            ...snapshot.tables.bottomTen,
            ...snapshot.tables.majorEconomies,
          ];
          for (const row of all) {
            assert.ok(
              row.dimensionCoverage >= 0 && row.dimensionCoverage <= 1,
              `${row.countryCode} dimensionCoverage=${row.dimensionCoverage} must be in [0, 1] (fraction, not percent)`,
            );
          }
        });

        it('published rows that overlap a band anchor set sit on the expected side', () => {
          // Structural check: bottomTen should not contain a high-band anchor,
          // and topTen should not contain a low-band anchor. Catches a
          // catastrophic label-swap or country-code mix-up.
          for (const row of snapshot.tables.topTen) {
            assert.ok(
              !LOW_BAND_ANCHORS.has(row.countryCode),
              `topTen must not include a low-band anchor, found ${row.countryCode}`,
            );
          }
          for (const row of snapshot.tables.bottomTen) {
            assert.ok(
              !HIGH_BAND_ANCHORS.has(row.countryCode),
              `bottomTen must not include a high-band anchor, found ${row.countryCode}`,
            );
          }
        });
      }

      if (isLive(snapshot)) {
        it('live items are monotonically non-increasing in overallScore', () => {
          for (let i = 1; i < snapshot.items.length; i++) {
            const prev = snapshot.items[i - 1]!;
            const curr = snapshot.items[i]!;
            assert.ok(
              curr.overallScore <= prev.overallScore,
              `items[${i}] (${curr.countryCode}=${curr.overallScore}) must not exceed items[${i - 1}] (${prev.countryCode}=${prev.overallScore})`,
            );
          }
        });

        it('live items have unique, contiguous ranks starting at 1', () => {
          const ranks = snapshot.items.map((item) => item.rank);
          for (let i = 0; i < ranks.length; i++) {
            assert.equal(ranks[i], i + 1, `items[${i}].rank should be ${i + 1}`);
          }
          const uniqueCodes = new Set(snapshot.items.map((item) => item.countryCode));
          assert.equal(uniqueCodes.size, snapshot.items.length, 'country codes in items[] must be unique');
        });

        it('live greyedOut items all have overallCoverage < the greyOut threshold', () => {
          for (const entry of snapshot.greyedOut) {
            assert.ok(
              entry.overallCoverage < snapshot.methodology.greyOutThreshold,
              `${entry.countryCode} in greyedOut with coverage=${entry.overallCoverage} must be below threshold ${snapshot.methodology.greyOutThreshold}`,
            );
          }
        });

        it('live totals match the embedded arrays', () => {
          assert.equal(snapshot.totals.rankedCountries, snapshot.items.length);
          assert.equal(snapshot.totals.greyedOutCount, snapshot.greyedOut.length);
        });

        it('live band anchors sit in their expected bands (structural sanity)', () => {
          for (const item of snapshot.items) {
            if (HIGH_BAND_ANCHORS.has(item.countryCode)) {
              assert.ok(
                item.overallScore >= HIGH_BAND_FLOOR,
                `${item.countryCode} is a high-band anchor but scored ${item.overallScore} (< ${HIGH_BAND_FLOOR}) at rank ${item.rank}`,
              );
            }
            if (LOW_BAND_ANCHORS.has(item.countryCode)) {
              assert.ok(
                item.overallScore <= LOW_BAND_CEILING,
                `${item.countryCode} is a low-band anchor but scored ${item.overallScore} (> ${LOW_BAND_CEILING}) at rank ${item.rank}`,
              );
            }
          }
        });
      }
    });
  }
});
