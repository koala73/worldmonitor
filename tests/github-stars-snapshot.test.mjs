import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  latestValidGithubStarsSnapshot,
  starsInteractionCounter,
} from '../scripts/github-stars-snapshot.mjs';

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'wm-stars-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('github stars snapshot lookup', () => {
  it('prefers the newest valid snapshot', () => {
    const dir = fixtureDir({
      'github-stars-2026-09-01.json': JSON.stringify({ stargazers_count: 1 }),
      'github-stars-2026-09-03.json': JSON.stringify({ stargazers_count: 3 }),
    });
    try {
      assert.equal(latestValidGithubStarsSnapshot(dir).stargazers_count, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back past a corrupt newest snapshot instead of failing the build', () => {
    const dir = fixtureDir({
      'github-stars-2026-09-01.json': JSON.stringify({ stargazers_count: 1 }),
      'github-stars-2026-09-03.json': '{not json',
    });
    try {
      const snapshot = latestValidGithubStarsSnapshot(dir);
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
