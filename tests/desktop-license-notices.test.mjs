/**
 * The desktop bundle must carry its licence and its third-party notices (#6977).
 *
 * Before this, the .dmg / .msi / NSIS / AppImage builds shipped none: no
 * licenceFile on the installers, no `license` or `credits` in the About dialog,
 * and no NOTICE file anywhere in the repo — while the bundle carries a compiled
 * Rust binary, a Node runtime, and the whole production npm tree. MIT, BSD and
 * Apache-2.0 all require their notice to travel with a binary distribution.
 *
 * The generated notices file itself is not committed (3MB+, regenerated per
 * build), so what is asserted here is the wiring that produces and ships it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

const NOTICES_RESOURCE = 'notices';

describe('desktop bundle ships its licence', () => {
  const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));

  it('installers display the licence', () => {
    assert.equal(
      tauriConfig.bundle.licenseFile,
      '../LICENSE',
      'without bundle.licenseFile the NSIS and WiX installers show no licence page',
    );
  });

  it('the notices file is bundled as a resource', () => {
    assert.ok(
      tauriConfig.bundle.resources.includes(NOTICES_RESOURCE),
      'the generated notices must ship inside the bundle, not just exist on the build machine',
    );
  });

  it('the desktop build generates the notices before packaging', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    assert.match(
      scripts['build:desktop'],
      /generate-third-party-notices\.mjs/,
      'build:desktop is the beforeBuildCommand — if it does not generate the notices, bundling a missing resource fails the build',
    );
    assert.equal(scripts.notices, 'node scripts/generate-third-party-notices.mjs');
  });

  it('the About dialog carries the licence on every platform', () => {
    const main = read('src-tauri/src/main.rs');
    // muda renders `license` on Windows/Linux and `credits` on macOS, so the
    // licence has to appear in both or one platform shows nothing.
    assert.match(main, /license: Some\("AGPL-3\.0-only"\.into\(\)\)/);
    assert.match(main, /credits: Some\(\s*"Licensed under AGPL-3\.0-only\./);
    assert.match(main, /THIRD-PARTY-NOTICES\.md/);
  });

  it('the copyright in the About dialog matches LICENSE', () => {
    const licenseYears = read('LICENSE').match(/Copyright \(C\) (\d{4}-\d{4}) Elie Habib/)?.[1];
    assert.ok(licenseYears, 'LICENSE must carry the project copyright line');
    assert.match(
      read('src-tauri/src/main.rs'),
      new RegExp(`\\\\u\\{00a9\\} ${licenseYears} Elie Habib`),
      `About dialog copyright drifted from LICENSE (${licenseYears})`,
    );
  });

  it('documents the licence where a user downloads the app', () => {
    const docs = read('docs/desktop-app.mdx');
    assert.match(docs, /AGPL-3\.0-only/);
    assert.match(docs, /THIRD-PARTY-NOTICES\.md/);
    assert.match(docs, /\(\/eula\)/, 'the desktop page must point at the EULA for the hosted-service half');
  });
});

describe('third-party notices generator', () => {
  it('lists real packages with their licence text', () => {
    // Runs the generator for real rather than trusting the committed output —
    // there is no committed output to trust.
    const out = execFileSync('node', [join(root, 'scripts/generate-third-party-notices.mjs')], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.match(out, /Wrote /);

    const notices = read('src-tauri/notices/THIRD-PARTY-NOTICES.md');
    const entries = [...notices.matchAll(/^### (.+)$/gm)];
    assert.ok(entries.length > 100, `expected the production tree, got ${entries.length} entries`);
    assert.match(notices, /^License: /m, 'each entry must state its licence');
    assert.match(notices, /MIT License/, 'expected at least one verbatim MIT text, not just SPDX ids');
    assert.match(notices, /Node\.js/, 'the bundled runtime must be accounted for');
  });

  it('--check fails on a notices file that is missing packages', () => {
    const target = join(root, 'src-tauri/notices/THIRD-PARTY-NOTICES.md');
    const backupDir = mkdtempSync(join(tmpdir(), 'wm-notices-'));
    const backup = join(backupDir, 'notices.md');
    writeFileSync(backup, read('src-tauri/notices/THIRD-PARTY-NOTICES.md'));

    try {
      writeFileSync(target, '# Third-party notices\n\n## npm packages\n\n0 packages.\n');
      let failed = false;
      try {
        execFileSync('node', [join(root, 'scripts/generate-third-party-notices.mjs'), '--check'], {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (err) {
        failed = true;
        assert.match(String(err.stderr), /stale/);
      }
      assert.ok(failed, '--check must reject a notices file that omits shipped packages');
    } finally {
      writeFileSync(target, readFileSync(backup, 'utf8'));
      rmSync(backupDir, { recursive: true, force: true });
    }
  });
});
