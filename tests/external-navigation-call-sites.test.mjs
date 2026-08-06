import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const callSiteFiles = [
  'src/components/Panel.ts',
  'src/components/ResilienceWidget.ts',
  'src/app/event-handlers.ts',
  'src/app/desktop-updater.ts',
  'src/settings-main.ts',
  'src/components/RuntimeConfigPanel.ts',
];

describe('external navigation call-site contract (#6120)', () => {
  it('routes every renderer open_url handoff through openExternalUrl', () => {
    const directOpenUrlCalls = [];
    const missingHelperImports = [];
    const missingHelperCalls = [];

    for (const relativePath of callSiteFiles) {
      const source = readFileSync(join(root, relativePath), 'utf8');
      if (/\binvokeTauri(?:<[^>]+>)?\(\s*['"]open_url['"]/.test(source)) {
        directOpenUrlCalls.push(relativePath);
      }
      if (!source.includes('external-navigation')) {
        missingHelperImports.push(relativePath);
      }
      if (!/\bopenExternalUrl\s*\(/.test(source)) {
        missingHelperCalls.push(relativePath);
      }
    }

    assert.deepEqual(directOpenUrlCalls, [], 'renderer call sites must not hand-roll open_url');
    assert.deepEqual(missingHelperImports, [], 'every migrated call site must import external-navigation');
    assert.deepEqual(missingHelperCalls, [], 'every migrated call site must call openExternalUrl');
  });

  /**
   * The three arms above are all satisfied by "the file mentions the helper
   * somewhere", so a file with two call sites could regress one and stay
   * green — proven by restoring the pre-fix `window.open` in settings-main.ts
   * and RuntimeConfigPanel.ts simultaneously. The bug shape is `window.open`,
   * so that is what this asserts, with the legitimate web-branch sites named
   * explicitly rather than allowed by omission.
   */
  it('leaves no unaccounted window.open in a migrated call site', () => {
    // Every entry is a WEB-branch open, reached only when the desktop test
    // above is false, so none of them can navigate a Tauri WebView. They are
    // fire-and-forget (the handle is never read), which is why passing
    // `noopener,noreferrer` — and getting null back — is harmless here.
    const ALLOWED_WINDOW_OPEN = new Map([
      ['src/components/Panel.ts', 1], //            web checkout fallback
      ['src/components/ResilienceWidget.ts', 2], // web upgrade fallbacks
      ['src/app/event-handlers.ts', 2], //          download-banner links
      ['src/app/desktop-updater.ts', 1], //         non-desktop update link
      ['src/settings-main.ts', 0],
      ['src/components/RuntimeConfigPanel.ts', 0],
    ]);

    const unaccounted = [];
    for (const relativePath of callSiteFiles) {
      const source = readFileSync(join(root, relativePath), 'utf8');
      const found = (source.match(/\bwindow\.open\s*\(/g) ?? []).length;
      const allowed = ALLOWED_WINDOW_OPEN.get(relativePath) ?? 0;
      if (found !== allowed) {
        unaccounted.push(`${relativePath}: ${found} window.open( (expected ${allowed})`);
      }
    }

    assert.deepEqual(
      unaccounted,
      [],
      'a migrated call site regained a raw window.open — route it through openExternalUrl, '
        + 'or add it to ALLOWED_WINDOW_OPEN with a reason',
    );
  });
});
