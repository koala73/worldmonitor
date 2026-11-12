import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { buildCorpus } from '../scripts/build-crawlable-corpus.mjs';
import { UMAMI_SCRIPT_TAG } from '../scripts/build-research-reports.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFileSync(join(repoRoot, path), 'utf8');

// scripts/ must not import src/, so read the dashboard's website ID as text.
const DASHBOARD_ID = read('src/services/analytics.ts')
  .match(/const UMAMI_WEBSITE_ID = '([0-9a-f-]{36})'/)?.[1];
const TRACKER_RE = /<script[^>]+abacus\.worldmonitor\.app\/script\.js[^>]*>/g;

describe('Umami tag on crawlable pages', () => {
  it('reads the dashboard website ID', () => {
    assert.ok(DASHBOARD_ID, 'UMAMI_WEBSITE_ID not found in src/services/analytics.ts');
  });

  it('shared tag uses the dashboard website ID', () => {
    assert.ok(UMAMI_SCRIPT_TAG.includes(`data-website-id="${DASHBOARD_ID}"`));
  });

  it('hand-written /agent page uses the dashboard website ID and no other', () => {
    const ids = [...read('public/agent/index.html').matchAll(/data-website-id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, [DASHBOARD_ID]);
  });

  describe('generated corpus', () => {
    let outDir;
    before(async () => {
      outDir = mkdtempSync(join(tmpdir(), 'wm-umami-tag-'));
      await buildCorpus({ rootDir: repoRoot, outDir, baseUrl: 'https://www.worldmonitor.app' });
    });
    after(() => {
      if (outDir) rmSync(outDir, { recursive: true, force: true });
    });

    const firstChild = (family) => {
      const dir = join(outDir, family);
      if (!existsSync(dir)) return null;
      const child = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'index.html')))
        .map((entry) => entry.name)
        .sort()[0];
      return child ? `${family}/${child}` : null;
    };

    it('renders exactly one tracker with the dashboard ID on each page family', () => {
      const families = {
        countries: firstChild('countries'),
        chokepoint: 'chokepoints/strait-of-hormuz',
        crises: firstChild('crises'),
        compare: firstChild('compare'),
        tools: firstChild('tools'),
        'use-cases hub': 'use-cases',
        'use-case page': firstChild('use-cases'),
        'research hub': 'research',
        'research report': firstChild('research'),
      };
      // A family that stops building must fail here, not drop out of the check.
      for (const [family, page] of Object.entries(families)) {
        assert.ok(page && existsSync(join(outDir, page, 'index.html')), `${family}: no page in the built corpus`);
      }
      for (const page of Object.values(families)) {
        const html = readFileSync(join(outDir, page, 'index.html'), 'utf8');
        const tags = html.match(TRACKER_RE) || [];
        assert.equal(tags.length, 1, `${page}: expected one Umami tag, found ${tags.length}`);
        assert.ok(tags[0].includes(`data-website-id="${DASHBOARD_ID}"`), `${page}: wrong website ID`);
      }
    });
  });
});
