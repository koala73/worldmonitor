import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let mod;
let digestSource;
let seederSource;

before(async () => {
  const result = await build({
    stdin: {
      contents: "export * from './scripts/_forecast-evidence-archive.mjs';",
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'forecast-evidence-archive-test-entry.ts',
    },
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const source = result.outputFiles[0]?.text;
  assert.ok(source, 'esbuild must emit the evidence archive harness');
  mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  digestSource = await readFile(resolve(root, 'server/worldmonitor/news/v1/list-feed-digest.ts'), 'utf8');
  seederSource = await readFile(resolve(root, 'scripts/seed-forecast-resolutions.mjs'), 'utf8');
});

describe('forecast evidence archive records (#7082)', () => {
  it('builds a self-contained member that round-trips through parse', () => {
    const member = mod.buildForecastEvidenceMember(
      {
        hash: 'a'.repeat(32),
        title: 'Central bank holds rates',
        link: 'https://news.example/rates',
        description: 'Officials held rates unchanged.',
        publishedAt: 1750000000000,
      },
      1750000100000,
    );
    assert.ok(member, 'member must build for a well-formed track');
    const { record, malformed, oversized } = mod.parseForecastEvidenceMember(member);
    assert.equal(malformed, false);
    assert.equal(oversized, false);
    assert.ok(record);
    assert.equal(record.hash, 'a'.repeat(32));
    assert.equal(record.title, 'Central bank holds rates');
    assert.equal(record.link, 'https://news.example/rates');
    assert.equal(record.publishedAt, 1750000000000);
    assert.equal(record.lastSeen, 1750000100000);
    assert.equal(record.v, mod.FORECAST_EVIDENCE_VERSION);
  });

  it('refuses members with missing required fields', () => {
    assert.equal(mod.buildForecastEvidenceMember({ hash: '', title: 'x', link: 'y', publishedAt: 1 }, 2), null);
    assert.equal(mod.buildForecastEvidenceMember({ hash: 'h', title: '', link: 'y', publishedAt: 1 }, 2), null);
    assert.equal(mod.buildForecastEvidenceMember({ hash: 'h', title: 't', link: 'y', publishedAt: NaN }, 2), null);
  });

  it('caps descriptions and refuses oversized members instead of archiving them', () => {
    const member = mod.buildForecastEvidenceMember(
      {
        hash: 'b'.repeat(32),
        title: 't'.repeat(2500),
        link: 'https://news.example/x',
        description: '',
        publishedAt: 1,
      },
      2,
    );
    assert.equal(member, null, 'a member over the byte budget must be dropped at build time');
  });

  it('reports malformed members as tombstones, never silently omitted', () => {
    for (const bad of ['not json', '42', 'null', JSON.stringify({ v: 99 }), JSON.stringify({ v: 1 })]) {
      const { record, malformed } = mod.parseForecastEvidenceMember(bad);
      assert.equal(record, null, `unusable member must not parse: ${bad.slice(0, 24)}`);
      assert.equal(malformed, true);
    }
  });

  it('archives only the full/English scope that judging reads', () => {
    assert.equal(mod.isEligibleForecastEvidence('full', 'en'), true);
    assert.equal(mod.isEligibleForecastEvidence('full', 'de'), false);
    assert.equal(mod.isEligibleForecastEvidence('tech', 'en'), false);
  });

  it('sizes retention for the 14-day reader contract plus a guard band', () => {
    assert.equal(mod.FORECAST_EVIDENCE_TTL_S, 15 * 24 * 60 * 60);
    assert.equal(mod.FORECAST_EVIDENCE_MAX_LOOKBACK_MS, 14 * 24 * 60 * 60 * 1000);
  });
});

describe('accumulator prune bounds (#7082)', () => {
  it('prunes strictly older than the 48-hour digest contract', () => {
    const now = 1750000000000;
    const bounds = mod.accumulatorPruneBounds(now);
    assert.equal(bounds.min, '-inf');
    assert.equal(bounds.max, String(now - 48 * 60 * 60 * 1000));
  });

  it('rejects a non-finite clock', () => {
    assert.throws(() => mod.accumulatorPruneBounds(NaN));
  });
});

describe('writer wiring (#7082)', () => {
  it('dual-publishes eligible evidence alongside the accumulator ZADD', () => {
    assert.match(digestSource, /FORECAST_EVIDENCE_KEY/);
    assert.match(digestSource, /buildForecastEvidenceMember\(/);
    assert.match(digestSource, /isEligibleForecastEvidence\(variant, lang\)/);
  });

  it('prunes accumulator members on publication (TTL is abandoned-key cleanup only)', () => {
    assert.match(digestSource, /ZREMRANGEBYSCORE', accKey/);
    assert.match(digestSource, /accumulatorPruneBounds/);
  });
});

describe('reader migration (#7082)', () => {
  it('judges from the dedicated archive first with the accumulator as fallback', () => {
    assert.match(seederSource, /readForecastEvidenceArchive/);
    assert.match(seederSource, /FORECAST_EVIDENCE_KEY/);
    assert.match(seederSource, /falling back to accumulator/);
    assert.match(seederSource, /parseForecastEvidenceMember/);
  });

  it('counts malformed archive members as tombstones instead of dropping them', () => {
    assert.match(seederSource, /malformedTombstones/);
  });
});
