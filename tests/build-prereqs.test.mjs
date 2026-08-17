// Unit tests for the build prerequisite preflight (scripts/check-build-prereqs.mjs).
//
// Regression motivation — the concrete failures this guards:
//
// 1. `apt-get install` is all-or-nothing. A hand-maintained package list that
//    named `libgobject-2.0-dev` (which has never existed in Debian/Ubuntu —
//    gobject-2.0 ships inside libglib2.0-dev) produced an install line that
//    failed as a whole, so the user installed NOTHING and saw only "has no
//    installation candidate" for the one bad name.
//
// 2. Ubuntu's t64 ABI transition renamed libfuse2 -> libfuse2t64 mid-LTS. A
//    table pinning either single name is wrong on one side of that boundary,
//    and AppImage bundling fails at the very end of a long Rust build.
//
// Both are why package names are CANDIDATE LISTS resolved against the archive,
// and why probes target capabilities (pkg-config modules, sonames) rather than
// package names.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BUILD_PREREQS,
  UNVERIFIED_PACKAGE_FAMILIES,
  commandExists,
  detectDistroFamily,
  resolvePackage,
  checkBuildPrereqs,
} from '../scripts/check-build-prereqs.mjs';

describe('detectDistroFamily', () => {
  test('matches on ID', () => {
    assert.equal(detectDistroFamily('ID=ubuntu\nVERSION_ID="24.04"')?.family, 'debian');
    assert.equal(detectDistroFamily('ID=fedora')?.family, 'fedora');
    assert.equal(detectDistroFamily('ID=arch')?.family, 'arch');
  });

  test('falls back to ID_LIKE so derivatives resolve', () => {
    // Mint/Pop!_OS/Rocky are the common contributor machines that would
    // otherwise print no install command at all.
    assert.equal(detectDistroFamily('ID=linuxmint\nID_LIKE="ubuntu debian"')?.family, 'debian');
    assert.equal(detectDistroFamily('ID="rocky"\nID_LIKE="rhel centos fedora"')?.family, 'fedora');
    assert.equal(detectDistroFamily('ID=manjaro\nID_LIKE=arch')?.family, 'arch');
  });

  test('handles quoted and unquoted values identically', () => {
    assert.equal(detectDistroFamily('ID="ubuntu"')?.family, detectDistroFamily('ID=ubuntu')?.family);
  });

  test('returns null for an unknown distro rather than guessing', () => {
    // A wrong install command is worse than none: it sends the user to a
    // package manager they do not have.
    assert.equal(detectDistroFamily('ID=voidlinux'), null);
    assert.equal(detectDistroFamily(''), null);
  });
});

describe('resolvePackage', () => {
  test('picks the candidate that exists in the archive', () => {
    const archiveHas = (name) => name === 'libfuse2t64';
    assert.equal(resolvePackage(['libfuse2t64', 'libfuse2'], archiveHas), 'libfuse2t64');
  });

  test('picks the older name when only it exists', () => {
    const archiveHas = (name) => name === 'libfuse2';
    assert.equal(resolvePackage(['libfuse2t64', 'libfuse2'], archiveHas), 'libfuse2');
  });

  test('falls back to the first candidate when the archive cannot be queried', () => {
    assert.equal(resolvePackage(['libfuse2t64', 'libfuse2'], null), 'libfuse2t64');
  });

  test('returns null when no archive candidate can be verified', () => {
    assert.equal(resolvePackage(['a', 'b'], () => false), null);
  });

  test('verifies a single candidate when archive resolution is required', () => {
    const checked = [];
    const archiveHas = (name) => {
      checked.push(name);
      return false;
    };
    assert.equal(resolvePackage('libglib2.0-dev', archiveHas), null);
    assert.deepEqual(checked, ['libglib2.0-dev']);
  });

  test('does not guess when a required archive is unavailable', () => {
    assert.equal(resolvePackage(['libfuse2t64', 'libfuse2'], null, { requireArchive: true }), null);
  });

  test('accepts a bare string as a one-element list', () => {
    assert.equal(resolvePackage('libglib2.0-dev', null), 'libglib2.0-dev');
  });

  test('returns null when a family deliberately has no package', () => {
    // arch/suse ship javascriptcoregtk inside webkit2gtk; naming it twice is
    // noise, and null must not leak into the install line.
    assert.equal(resolvePackage(null, null), null);
    assert.equal(resolvePackage([null], null), null);
  });
});

describe('BUILD_PREREQS table', () => {
  test('every entry has a probe, a scope and a reason', () => {
    for (const p of BUILD_PREREQS) {
      assert.ok(p.id, 'entry missing id');
      assert.ok(['web', 'desktop'].includes(p.scope), `${p.id}: scope must be web or desktop`);
      assert.ok(p.why, `${p.id}: missing why — this table is the decision record`);
      assert.ok(p.probe?.kind, `${p.id}: missing probe`);
    }
  });

  test('ids are unique', () => {
    const ids = BUILD_PREREQS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('never names libgobject-2.0-dev', () => {
    // The exact name that made the original install line uninstallable.
    const debianPackages = BUILD_PREREQS.flatMap((p) => {
      const v = p.packages?.debian;
      return Array.isArray(v) ? v : [v];
    }).filter(Boolean);
    assert.ok(!debianPackages.includes('libgobject-2.0-dev'));
    assert.ok(debianPackages.includes('libglib2.0-dev'), 'gobject-2.0 must come from libglib2.0-dev');
  });

  test('webkit is pinned to the 4.1 line Tauri v2 requires', () => {
    // 4.0 is the Tauri v1 / libsoup2 pairing and does not satisfy this build.
    const webkit = BUILD_PREREQS.find((p) => p.id === 'webkit2gtk');
    assert.equal(webkit.probe.module, 'webkit2gtk-4.1');
    const soup = BUILD_PREREQS.find((p) => p.id === 'libsoup3');
    assert.equal(soup.probe.module, 'libsoup-3.0');
  });

  test('fuse is probed by soname, not by package or command name', () => {
    // Both of those vary per distro and per release; the soname does not.
    const fuse = BUILD_PREREQS.find((p) => p.id === 'fuse2');
    assert.equal(fuse.probe.kind, 'soname');
    assert.equal(fuse.probe.soname, 'libfuse.so.2');
  });

  test('unverified families are declared, and verified ones are not', () => {
    // The point of this set is that a guessed package name is never printed as
    // fact. Debian is archive-resolved at runtime and must never appear here.
    assert.ok(UNVERIFIED_PACKAGE_FAMILIES.has('suse'));
    assert.ok(!UNVERIFIED_PACKAGE_FAMILIES.has('debian'));
  });

  test('every suse entry carrying a TODO is covered by the unverified set', () => {
    // Guards the inverse mistake: dropping the family from the set while
    // TODO-marked guesses are still in the table.
    const source = readFileSync(new URL('../scripts/check-build-prereqs.mjs', import.meta.url), 'utf8');
    if (/TODO\(suse\)/.test(source)) {
      assert.ok(UNVERIFIED_PACKAGE_FAMILIES.has('suse'), 'TODO(suse) markers remain — keep suse unverified');
    }
  });

  test('every linux-only entry that needs a package names one for each family', () => {
    for (const p of BUILD_PREREQS.filter((x) => x.platform === 'linux' && x.packages)) {
      for (const family of ['debian', 'fedora', 'arch', 'suse']) {
        assert.ok(family in p.packages, `${p.id}: no decision recorded for ${family}`);
      }
    }
  });
});

describe('checkBuildPrereqs scoping', () => {
  test('web scope never asks for GTK', () => {
    // A contributor who only touches the web app must never be told to
    // install a desktop toolkit.
    const { results } = checkBuildPrereqs({ scope: 'web', platform: 'linux' });
    assert.ok(results.every((r) => r.prereq.scope === 'web'));
    assert.ok(!results.some((r) => r.prereq.id === 'gtk3'));
  });

  test('desktop scope includes the shared Node floor', () => {
    const { results } = checkBuildPrereqs({
      scope: 'desktop',
      platform: 'darwin',
      dependencies: { runProbe: () => ({ ok: true, detail: 'stubbed' }) },
    });
    assert.ok(results.some((r) => r.prereq.id === 'node'));
  });

  test('desktop scope fails when the shared Node floor fails', () => {
    const { missing } = checkBuildPrereqs({
      scope: 'desktop',
      platform: 'darwin',
      dependencies: {
        runProbe: (probe) => probe.kind === 'node-major'
          ? { ok: false, detail: 'found v20.0.0' }
          : { ok: true, detail: 'stubbed' },
      },
    });
    assert.ok(missing.some((r) => r.prereq.id === 'node'));
  });

  test('linux-only entries are skipped on other platforms', () => {
    const { results } = checkBuildPrereqs({
      scope: 'desktop',
      platform: 'darwin',
      dependencies: { runProbe: () => ({ ok: true, detail: 'stubbed' }) },
    });
    assert.ok(!results.some((r) => r.prereq.platform === 'linux'));
    // Rust is still required on macOS.
    assert.ok(results.some((r) => r.prereq.id === 'rustc'));
  });

  test('desktop development excludes bundling prerequisites', () => {
    const { results } = checkBuildPrereqs({
      scope: 'desktop',
      platform: 'linux',
      dependencies: { runProbe: () => ({ ok: true, detail: 'stubbed' }) },
    });
    assert.ok(!results.some((r) => r.prereq.bundleOnly));
  });

  test('desktop bundle scope on linux includes the bundling prerequisites', () => {
    const { results } = checkBuildPrereqs({
      scope: 'desktop',
      bundle: true,
      platform: 'linux',
      dependencies: { runProbe: () => ({ ok: true, detail: 'stubbed' }) },
    });
    for (const id of ['webkit2gtk', 'librsvg', 'patchelf', 'fuse2']) {
      assert.ok(results.some((r) => r.prereq.id === id), `missing ${id}`);
    }
  });

  test('blocked pkg-config probes are not reported as confirmed missing', () => {
    const { missing, blocked } = checkBuildPrereqs({
      scope: 'desktop',
      platform: 'linux',
      family: { family: 'debian', install: 'sudo apt-get install -y' },
      dependencies: {
        commandExists: () => false,
        archiveHas: null,
        runProbe: (probe) => {
          if (probe.kind === 'pkg-config') {
            return { ok: false, detail: 'pkg-config unavailable', skipped: true };
          }
          if (probe.kind === 'command' && probe.command === 'pkg-config') {
            return { ok: false, detail: 'pkg-config' };
          }
          return { ok: true, detail: 'stubbed' };
        },
      },
    });

    assert.deepEqual(missing.map((r) => r.prereq.id), ['pkg-config']);
    assert.ok(blocked.length > 0);
    assert.ok(blocked.every((r) => r.skipped));
  });

  test('Debian install commands do not receive unverified package names', () => {
    const { missing } = checkBuildPrereqs({
      scope: 'desktop',
      platform: 'linux',
      family: { family: 'debian', install: 'sudo apt-get install -y' },
      dependencies: {
        archiveHas: () => false,
        runProbe: (probe) => probe.kind === 'command' && probe.command === 'pkg-config'
          ? { ok: false, detail: 'pkg-config' }
          : { ok: true, detail: 'stubbed' },
      },
    });

    const pkgConfig = missing.find((r) => r.prereq.id === 'pkg-config');
    assert.equal(pkgConfig.pkg, null);
  });
});

describe('command lookup', () => {
  test('uses where.exe instead of a POSIX shell on native Windows', () => {
    const calls = [];
    const exec = (file, args) => calls.push({ file, args });

    assert.equal(commandExists('rustc', { platform: 'win32', exec }), true);
    assert.deepEqual(calls, [{ file: 'where.exe', args: ['rustc'] }]);
  });
});

describe('package script wiring', () => {
  test('desktop development and bundling use different prerequisite modes', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.match(packageJson.scripts['desktop:dev'], /^npm run check:prereqs:desktop &&/);
    assert.match(
      packageJson.scripts['desktop:tauri:build'],
      /^npm run security:vite-env-secrets -- --strict-local && npm run check:prereqs:desktop:bundle &&/,
    );
    assert.match(packageJson.scripts['check:prereqs:desktop:bundle'], /--scope desktop --bundle$/);
  });
});

describe('CLI output', () => {
  test('JSON output exposes explicit status without dropping the ok field', () => {
    const script = fileURLToPath(new URL('../scripts/check-build-prereqs.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--scope', 'web', '--json'], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.scope, 'web');
    assert.equal(payload.bundle, false);
    assert.deepEqual(payload.results.map((item) => item.id), ['node']);
    assert.equal(payload.results[0].ok, true);
    assert.equal(payload.results[0].status, 'present');
  });
});
