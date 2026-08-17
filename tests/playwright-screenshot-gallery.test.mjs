import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildGallery,
  escapeHtml,
  renderScreenshotGallery,
  titleFromFileName,
  updateRunHistory,
} from '../scripts/playwright-screenshot-gallery.mjs';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('playwright screenshot gallery', () => {
  it('titles numbered captures as a scan story', () => {
    assert.equal(titleFromFileName('01-harness-ready.png'), 'harness ready');
    assert.equal(titleFromFileName('04-protests-z5.png'), 'protests z5');
  });

  it('escapes screenshot labels so a filename cannot break out of the gallery', () => {
    const html = renderScreenshotGallery({
      createdAt: '2026-08-17T10:00:00.000Z',
      result: 'success',
      sha: 'abcdef1234567890',
      screenshots: [
        {
          fileName: 'images/001-shell.png',
          source: 'golden/<script>.png',
          title: 'main <script>alert(1)</script>',
        },
      ],
    });

    assert.match(html, /src="images\/001-shell.png"/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.equal(escapeHtml('main <script>alert(1)</script>'), 'main \u0026lt;script\u0026gt;alert(1)\u0026lt;/script\u0026gt;');
    assert.match(html, /main \u0026lt;script\u0026gt;alert\(1\)\u0026lt;\/script\u0026gt;/);
    assert.match(html, /golden\/\u0026lt;script\u0026gt;\.png/);
  });

  it('keeps the newest run first and drops malformed history', () => {
    const previous = {
      attempt: 1,
      branch: 'main',
      createdAt: '2026-08-16T10:00:00.000Z',
      event: 'schedule',
      id: '100',
      reportUrl: '',
      result: 'success',
      runNumber: 8,
      runUrl: '',
      screenshotCount: 3,
      screenshotsUrl: '',
      sha: '1111111',
    };
    const current = { ...previous, id: '200', runNumber: 9, sha: '2222222' };

    const history = updateRunHistory([previous, { id: 'broken' }, null], current);
    assert.equal(history[0]?.id, '200');
    assert.equal(history[1]?.id, '100');
    assert.equal(history.length, 2);
  });

  it('collects named pngs from a test-results tree and writes the gallery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wm-gallery-'));
    try {
      const results = join(root, 'test-results');
      const output = join(root, 'gallery');
      mkdirSync(join(results, 'visual-chrome-captures'), { recursive: true });
      mkdirSync(join(results, 'visual-chrome-captures', 'attachments'), { recursive: true });
      writeFileSync(join(results, 'visual-chrome-captures', '01-harness-ready.png'), PNG_BYTES);
      writeFileSync(join(results, 'visual-chrome-captures', '07-mobile-harness.png'), PNG_BYTES);
      writeFileSync(
        join(results, 'visual-chrome-captures', 'attachments', '01-harness-ready.png'),
        PNG_BYTES,
      );

      const { screenshots, history } = await buildGallery({
        resultsDir: results,
        outputDir: output,
        meta: {
          attempt: 1,
          branch: 'main',
          createdAt: '2026-08-17T12:00:00.000Z',
          event: 'schedule',
          id: '315',
          result: 'success',
          runNumber: 12,
          sha: 'deadbeefcafebabe',
        },
      });

      assert.equal(screenshots.length, 2);
      assert.equal(screenshots[0].title, 'harness ready');
      assert.equal(history[0].screenshotCount, 2);

      const gallery = readFileSync(join(output, 'screenshots', 'index.html'), 'utf8');
      assert.match(gallery, /01-harness-ready/);
      assert.match(gallery, /07-mobile-harness/);
      assert.match(readFileSync(join(output, 'index.html'), 'utf8'), /World Monitor/);
      assert.match(readFileSync(join(output, 'history.json'), 'utf8'), /"id": "315"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
