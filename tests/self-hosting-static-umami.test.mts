import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  isAnalyticsBuildEnabled,
  stripUmamiScriptTags,
  stripUmamiScriptTagsInDir,
} from '../shared/analytics-static-pages.ts';
import { UMAMI_SCRIPT_TAG } from '../scripts/build-research-reports.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

const TRACKER_RE = /<script[^>]+abacus\.worldmonitor\.app\/script\.js[^>]*>/;

const corpusShell = `<!doctype html>
<html>
  <body>
    <main><p>Report</p></main>
    <script nonce="wm-static-bootstrap">window.x = 1;</script>
    ${UMAMI_SCRIPT_TAG}
  </body>
</html>
`;

const STATIC_PAGES: Array<[string, string]> = [
  ['pro-test/index.html', read('pro-test/index.html')],
  ['pro-test/welcome.html', read('pro-test/welcome.html')],
  ['public/agent/index.html', read('public/agent/index.html')],
  ['crawlable corpus shell', corpusShell],
];

describe('VITE_ANALYTICS_ENABLED build switch', () => {
  it('stays on unless the value is exactly false', () => {
    assert.equal(isAnalyticsBuildEnabled({}), true);
    assert.equal(isAnalyticsBuildEnabled({ VITE_ANALYTICS_ENABLED: undefined }), true);
    assert.equal(isAnalyticsBuildEnabled({ VITE_ANALYTICS_ENABLED: '' }), true);
    assert.equal(isAnalyticsBuildEnabled({ VITE_ANALYTICS_ENABLED: 'true' }), true);
    assert.equal(isAnalyticsBuildEnabled({ VITE_ANALYTICS_ENABLED: 'false' }), false);
  });
});

describe('Dockerfile build args for the self-hosting switches', () => {
  const SWITCH_ARGS = ['VITE_ANALYTICS_ENABLED', 'VITE_LIVE_MEDIA_PANELS_ENABLED', 'VITE_COUNTRY_OVERRIDES_URL', 'VITE_PMTILES_URL'];
  for (const dockerfile of ['Dockerfile', 'docker/Dockerfile']) {
    it(`${dockerfile} declares every switch before the first frontend build`, () => {
      const source = read(dockerfile);
      const firstBuild = source.indexOf('RUN npm run build:pro');
      assert.ok(firstBuild > 0, `${dockerfile} builds /pro`);
      assert.ok(firstBuild < source.indexOf('npx vite build'), `${dockerfile} builds /pro before the dashboard`);
      for (const name of SWITCH_ARGS) {
        const declared = source.search(new RegExp(`^ARG ${name}(?:=|$)`, 'm'));
        assert.ok(declared >= 0 && declared < firstBuild, `${dockerfile} declares ${name} before build:pro`);
      }
    });
  }
});

describe('static pages with a hardcoded Umami tag', () => {
  for (const [name, html] of STATIC_PAGES) {
    it(`${name} ships the tag in its source`, () => {
      assert.match(html, TRACKER_RE);
    });

    it(`${name} has no Umami tag once stripped and keeps everything else`, () => {
      const stripped = stripUmamiScriptTags(html);
      assert.doesNotMatch(stripped, /abacus\.worldmonitor\.app\/script\.js/);
      const removedLines = html.split('\n').filter((line) => !stripped.split('\n').includes(line));
      assert.equal(removedLines.length, 1, `${name}: exactly the tag line is removed`);
      assert.match(removedLines[0], TRACKER_RE);
    });
  }

  it('leaves a page without the tag byte-for-byte unchanged', () => {
    const html = read('index.html');
    assert.equal(stripUmamiScriptTags(html), html);
  });
});

describe('stripUmamiScriptTagsInDir', () => {
  let outDir: string;
  const untouched = '<!doctype html><html><body>no tracker</body></html>\n';

  before(() => {
    outDir = mkdtempSync(join(tmpdir(), 'wm-static-umami-'));
    mkdirSync(join(outDir, 'pro'), { recursive: true });
    mkdirSync(join(outDir, 'agent'), { recursive: true });
    writeFileSync(join(outDir, 'pro', 'index.html'), read('pro-test/index.html'));
    writeFileSync(join(outDir, 'pro', 'welcome.html'), read('pro-test/welcome.html'));
    writeFileSync(join(outDir, 'agent', 'index.html'), read('public/agent/index.html'));
    writeFileSync(join(outDir, 'plain.html'), untouched);
    writeFileSync(join(outDir, 'notes.txt'), UMAMI_SCRIPT_TAG);
  });

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('removes the tag from every page in the build output and nothing else', async () => {
    const rewritten = await stripUmamiScriptTagsInDir(outDir);
    assert.deepEqual(rewritten, [join('agent', 'index.html'), join('pro', 'index.html'), join('pro', 'welcome.html')]);
    for (const page of rewritten) {
      assert.doesNotMatch(readFileSync(join(outDir, page), 'utf8'), TRACKER_RE, page);
    }
    assert.equal(readFileSync(join(outDir, 'plain.html'), 'utf8'), untouched);
    assert.equal(readFileSync(join(outDir, 'notes.txt'), 'utf8'), UMAMI_SCRIPT_TAG);
  });

  it('treats a missing output directory as nothing to rewrite', async () => {
    assert.deepEqual(await stripUmamiScriptTagsInDir(join(outDir, 'missing')), []);
  });
});
