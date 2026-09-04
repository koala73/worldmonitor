import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  latestValidGithubStarsSnapshot,
  MAX_GITHUB_STARS_SNAPSHOT_AGE_DAYS,
  starsInteractionCounter,
} from '../scripts/github-stars-snapshot.mjs';

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'wm-stars-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function snapshot(capturedAt, stargazersCount, repository = 'koala73/worldmonitor') {
  return JSON.stringify({
    repository,
    stargazers_count: stargazersCount,
    capturedAt,
  });
}

describe('github stars snapshot lookup', () => {
  it('prefers the newest valid snapshot', () => {
    const dir = fixtureDir({
      'github-stars-2026-09-01.json': snapshot('2026-09-01', 1),
      'github-stars-2026-09-03.json': snapshot('2026-09-03', 3),
    });
    try {
      assert.equal(latestValidGithubStarsSnapshot(dir, '2026-09-04').stargazers_count, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back past a corrupt newest snapshot instead of failing the build', () => {
    const dir = fixtureDir({
      'github-stars-2026-09-01.json': snapshot('2026-09-01', 1),
      'github-stars-2026-09-03.json': '{not json',
    });
    try {
      const snapshot = latestValidGithubStarsSnapshot(dir, '2026-09-04');
      assert.equal(snapshot.stargazers_count, 1);
      assert.equal(snapshot.snapshotFile, 'github-stars-2026-09-01.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed naming remediation when no valid snapshot exists', () => {
    const empty = fixtureDir({});
    const bad = fixtureDir({ 'github-stars-2026-09-03.json': JSON.stringify({ stargazers_count: 'many' }) });
    try {
      assert.throws(() => latestValidGithubStarsSnapshot(empty), /freeze:github-stars/);
      assert.throws(() => latestValidGithubStarsSnapshot(bad), /freeze:github-stars/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(bad, { recursive: true, force: true });
    }
  });

  it('rejects snapshots captured from a different repository', () => {
    const dir = fixtureDir({
      'github-stars-2026-09-03.json': snapshot('2026-09-03', 42, 'someone/else'),
    });
    try {
      assert.throws(
        () => latestValidGithubStarsSnapshot(dir, '2026-09-04'),
        /repository must be koala73\/worldmonitor/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed and filename-mismatched capture dates', () => {
    const malformed = fixtureDir({
      'github-stars-2026-09-03.json': snapshot('2026-02-30', 42),
    });
    const mismatched = fixtureDir({
      'github-stars-2026-09-03.json': snapshot('2026-09-02', 42),
    });
    try {
      assert.throws(
        () => latestValidGithubStarsSnapshot(malformed, '2026-09-04'),
        /capturedAt must be a real YYYY-MM-DD calendar date/,
      );
      assert.throws(
        () => latestValidGithubStarsSnapshot(mismatched, '2026-09-04'),
        /capturedAt 2026-09-02 does not match filename date 2026-09-03/,
      );
    } finally {
      rmSync(malformed, { recursive: true, force: true });
      rmSync(mismatched, { recursive: true, force: true });
    }
  });

  it('rejects snapshots captured after the current UTC date', () => {
    const dir = fixtureDir({
      'github-stars-2026-09-05.json': snapshot('2026-09-05', 42),
    });
    try {
      assert.throws(
        () => latestValidGithubStarsSnapshot(dir, '2026-09-04'),
        /capturedAt 2026-09-05 is in the future/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the newest valid snapshot is older than the freshness bound', () => {
    const dir = fixtureDir({
      'github-stars-2026-07-01.json': snapshot('2026-07-01', 42),
    });
    try {
      // 2026-07-01 is 65 days before 2026-09-04: past the bound, so the
      // build must red instead of publishing a rotting figure (#7641).
      assert.throws(
        () => latestValidGithubStarsSnapshot(dir, '2026-09-04'),
        /days old \(max \d+\); run npm run freeze:github-stars/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a snapshot exactly at the freshness bound', () => {
    const capturedAt = '2026-07-21'; // 45 days before 2026-09-04
    const dir = fixtureDir({
      [`github-stars-${capturedAt}.json`]: snapshot(capturedAt, 42),
    });
    try {
      const found = latestValidGithubStarsSnapshot(dir, '2026-09-04');
      assert.equal(found.stargazers_count, 42);
      assert.equal(found.snapshotFile, `github-stars-${capturedAt}.json`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The refresh cron and the staleness ceiling are one contract (mirrors the
  // pulse cadence guard in tests/crawlable-corpus.test.mjs): relaxing one
  // alone silently reopens the rotting-figure gap from #7641.
  it('keeps the star-snapshot staleness ceiling within reach of the refresh cron', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/github-stars-refresh.yml', import.meta.url),
      'utf8',
    );
    const cron = workflow.match(/^\s*- cron: '([^']+)'/m)?.[1];
    assert.ok(cron, 'the star refresh workflow must declare a cron schedule');

    const [, , dayOfMonth, month, dayOfWeek] = cron.split(/\s+/);
    let cadenceDays;
    if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') cadenceDays = 7;
    else if (dayOfMonth !== '*' && month === '*') cadenceDays = 31;
    else if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') cadenceDays = 1;
    else assert.fail(`unrecognised star refresh cadence: ${cron}`);

    assert.ok(
      MAX_GITHUB_STARS_SNAPSHOT_AGE_DAYS > cadenceDays,
      `the ${MAX_GITHUB_STARS_SNAPSHOT_AGE_DAYS}-day ceiling must exceed the ${cadenceDays}-day refresh cadence, or a healthy refresh cycle reds the build`,
    );
    assert.ok(
      MAX_GITHUB_STARS_SNAPSHOT_AGE_DAYS <= cadenceDays * 2,
      `the ${MAX_GITHUB_STARS_SNAPSHOT_AGE_DAYS}-day ceiling tolerates more than two missed ${cadenceDays}-day refreshes; the published figure would rot that long`,
    );
  });

  it('builds the InteractionCounter shape the homepage publishes', () => {
    assert.deepEqual(starsInteractionCounter({ stargazers_count: 85478 }), {
      '@type': 'InteractionCounter',
      interactionType: 'https://schema.org/LikeAction',
      name: 'GitHub stars',
      userInteractionCount: 85478,
    });
  });
});

describe('freeze-github-stars', () => {
  it('throws without writing on non-OK status or invalid counts', async () => {
    const { freezeGithubStars } = await import('../scripts/freeze-github-stars.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'wm-freeze-'));
    try {
      const badStatus = () => Promise.resolve({ ok: false, status: 403 });
      await assert.rejects(
        freezeGithubStars({ fetchImpl: badStatus, outputDir: dir, today: '2026-09-03' }),
        /403/,
      );
      const badCount = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      await assert.rejects(
        freezeGithubStars({ fetchImpl: badCount, outputDir: dir, today: '2026-09-03' }),
        /no stargazers_count/,
      );
      assert.equal(readdirSync(dir).length, 0, 'failed freezes must not write snapshots');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the snapshot shape on a valid payload', async () => {
    const { freezeGithubStars } = await import('../scripts/freeze-github-stars.mjs');
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'wm-freeze-'));
    try {
      const ok = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ stargazers_count: 42 }) });
      const { path, snapshot } = await freezeGithubStars({ fetchImpl: ok, outputDir: dir, today: '2026-09-03' });
      assert.deepEqual(snapshot, { repository: 'koala73/worldmonitor', stargazers_count: 42, capturedAt: '2026-09-03' });
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), snapshot);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('injectStarsInteractionCounter', () => {
  const wrap = (node) =>
    `<html><head><script type="application/ld+json">${JSON.stringify(node)}</script></head><body></body></html>`;

  it('populates the #software node and never double-injects', async () => {
    const { injectStarsInteractionCounter } = await import('../scripts/github-stars-snapshot.mjs');
    const page = {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      '@id': 'https://www.worldmonitor.app/#software',
    };
    const first = injectStarsInteractionCounter(wrap(page), { stargazers_count: 42 });
    assert.equal(first.injected, true);
    assert.match(first.html, /"userInteractionCount": 42/);
    const second = injectStarsInteractionCounter(first.html, { stargazers_count: 43 });
    assert.equal(second.injected, false);
    assert.match(second.html, /"userInteractionCount": 42/);
  });

  it('leaves pages without a #software node untouched', async () => {
    const { injectStarsInteractionCounter } = await import('../scripts/github-stars-snapshot.mjs');
    const html = wrap({ '@context': 'https://schema.org', '@type': 'WebPage' });
    const { html: next, injected } = injectStarsInteractionCounter(html, { stargazers_count: 1 });
    assert.equal(injected, false);
    assert.equal(next, html);
  });
});
