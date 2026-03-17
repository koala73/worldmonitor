import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const mainRs = readFileSync(path.join(repoRoot, 'src-tauri', 'src', 'main.rs'), 'utf8');

test('macOS updater preserves bundle signatures when installing app updates', () => {
  assert.match(
    mainRs,
    /Command::new\("ditto"\)/,
    'updater should use ditto to preserve bundle metadata and _CodeSignature during install',
  );
  assert.doesNotMatch(
    mainRs,
    /Command::new\("cp"\)\s*\.args\(\["-r", &source, dest\]\)/,
    'updater should not use cp -r for app bundle installs because it can break code signatures',
  );
  assert.match(
    mainRs,
    /Copy to install path failed/,
    'install path should still surface copy failures clearly without hardcoding /Applications',
  );
  assert.match(
    mainRs,
    /verify_app_bundle_signature\(&dest, "Installed app"\)/,
    'updater should verify the installed bundle signature after copying before relaunching',
  );
  assert.match(
    mainRs,
    /resolve_update_install_path|current_exe/,
    'updater should resolve the active install path instead of hardcoding /Applications',
  );
  assert.doesNotMatch(
    mainRs,
    /let dest = "\/Applications\/World Monitor\.app";/,
    'updater should not hardcode /Applications as the install destination',
  );
  assert.match(
    mainRs,
    /staged|backup/,
    'updater should stage a verified replacement and preserve the current install until swap time',
  );
  assert.doesNotMatch(
    mainRs,
    /Command::new\("rm"\)\.args\(\["-rf", dest\]\)/,
    'updater should not delete the current install before a verified replacement exists',
  );
});
