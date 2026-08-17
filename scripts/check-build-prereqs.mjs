#!/usr/bin/env node
/**
 * Build prerequisite preflight.
 *
 * Before this check, a missing system library surfaced as whatever the tool
 * that tripped over it chose to say. The worst of them is the Linux desktop
 * bundle: `linuxdeploy-plugin-gtk` resolves the SVG pixbuf loader through
 * `pkg-config --variable=libdir librsvg-2.0`, so without librsvg2's .pc file
 * tauri reports only "failed to run linuxdeploy" — after the Rust build has
 * already run. The information needed to fix it exists before a single crate
 * compiles; this script surfaces it there instead.
 *
 * Three properties the ad-hoc `pkg-config --exists || echo` chains lacked:
 *
 * 1. It reports EVERY missing prerequisite in one pass. Fail-on-first turns a
 *    six-package gap into six sudo/build round-trips.
 * 2. It probes CAPABILITIES (pkg-config modules, sonames, commands) and maps
 *    to package names only when printing. The probe is what the build actually
 *    needs; the package name is distro trivia that varies and goes stale.
 * 3. Package names are resolved against the archive where that is possible, so
 *    a rename cannot produce an install line that fails as a whole. `apt-get
 *    install` is all-or-nothing: one wrong name and the user installs nothing
 *    and is told only that a package "has no installation candidate". The
 *    Ubuntu t64 ABI transition renamed libfuse2 -> libfuse2t64 mid-LTS, which
 *    is exactly this failure.
 *
 * Scopes: `web` prerequisites gate any build; `desktop` adds the Tauri
 * development requirements; `--bundle` also checks release-only packaging
 * tools. A contributor who never touches the desktop app is never asked to
 * install GTK.
 *
 * Run: node scripts/check-build-prereqs.mjs [--scope web|desktop|all]
 *                                           [--bundle] [--json] [--warn-only]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { isMainModule } from './lib/main-module.mjs';

// Node floor tracks the lowest version CI actually builds on
// (.github/workflows pins 22 and 24). Raise this when the 22 leg goes.
const MIN_NODE_MAJOR = 22;

/**
 * Distro families we can name packages for. `id` matches os-release ID;
 * `like` matches ID_LIKE, which is what derivatives (Mint, Pop!_OS, Rocky)
 * set. Unknown distros still get a correct capability report — they just get
 * the pkg-config module names instead of an install command.
 */
const DISTRO_FAMILIES = [
  { family: 'debian', ids: ['debian', 'ubuntu'], install: 'sudo apt-get install -y' },
  { family: 'fedora', ids: ['fedora', 'rhel', 'centos'], install: 'sudo dnf install -y' },
  { family: 'arch', ids: ['arch'], install: 'sudo pacman -S --needed' },
  { family: 'suse', ids: ['opensuse', 'suse', 'sles'], install: 'sudo zypper install -y' },
];

/**
 * Families whose package names have NOT been checked against a live archive.
 *
 * TODO(suse): verify every `packages.suse` entry against a real openSUSE
 * Tumbleweed/Leap zypper archive and drop this set. They were written from
 * naming convention, not observation, and openSUSE splits and renames the GTK
 * stack more than the others (`libsoup-3_0-devel` vs `libsoup3-devel` is the
 * live doubt). Debian names are archive-resolved at runtime, Fedora and Arch
 * were checked by hand; only these are guesses.
 *
 * Callers must not silently present a guess as fact — `report()` prints a
 * caveat for any family named here.
 */
export const UNVERIFIED_PACKAGE_FAMILIES = new Set(['suse']);

/**
 * The prerequisite table — the decision record for what this repo needs.
 *
 * `probe` is the ground truth. `packages` is per-family, and each value is a
 * CANDIDATE LIST in preference order: the first name that exists in the local
 * archive wins, so ABI renames (libfuse2 -> libfuse2t64) resolve correctly
 * without this table needing to know the distro version. A single string is
 * shorthand for a one-element list.
 */
export const BUILD_PREREQS = [
  {
    id: 'node',
    scope: 'web',
    why: `Node >=${MIN_NODE_MAJOR} — the version CI builds on`,
    probe: { kind: 'node-major', min: MIN_NODE_MAJOR },
    hint: 'Install via nvm (https://github.com/nvm-sh/nvm) or your distro packages.',
  },
  {
    id: 'rustc',
    scope: 'desktop',
    why: 'Rust toolchain — compiles the Tauri shell in src-tauri/',
    probe: { kind: 'command', command: 'rustc' },
    hint: "Install via rustup: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
  },
  {
    id: 'cargo',
    scope: 'desktop',
    why: 'Cargo — drives the src-tauri build',
    probe: { kind: 'command', command: 'cargo' },
    hint: 'Ships with rustup; if rustc exists but cargo does not, run `rustup component add cargo`.',
  },
  {
    id: 'pkg-config',
    scope: 'desktop',
    platform: 'linux',
    why: 'pkg-config — how the Rust build and linuxdeploy locate every native library below',
    probe: { kind: 'command', command: 'pkg-config' },
    packages: { debian: 'pkg-config', fedora: 'pkgconf-pkg-config', arch: 'pkgconf', suse: 'pkg-config' },
  },
  {
    id: 'webkit2gtk',
    scope: 'desktop',
    platform: 'linux',
    // Tauri v2 (src-tauri/Cargo.toml pins `tauri = ">=2.11.1, <3"`) is on the
    // 4.1 / libsoup3 line. 4.0 is the Tauri v1 pairing and will NOT satisfy it.
    why: 'WebKitGTK 4.1 — the webview Tauri v2 renders into',
    probe: { kind: 'pkg-config', module: 'webkit2gtk-4.1' },
    packages: {
      debian: 'libwebkit2gtk-4.1-dev',
      fedora: 'webkit2gtk4.1-devel',
      arch: 'webkit2gtk-4.1',
      suse: 'webkit2gtk3-devel', // TODO(suse): unverified; openSUSE may split the 4.1/soup3 build out
    },
  },
  {
    id: 'javascriptcoregtk',
    scope: 'desktop',
    platform: 'linux',
    why: 'JavaScriptCoreGTK 4.1 — WebKit JS engine headers',
    probe: { kind: 'pkg-config', module: 'javascriptcoregtk-4.1' },
    packages: {
      debian: 'libjavascriptcoregtk-4.1-dev',
      fedora: 'javascriptcoregtk4.1-devel',
      // arch/suse ship this inside the webkit2gtk package; naming it again is
      // harmless with --needed but noise, so leave it to the webkit entry.
      arch: null,
      suse: null,
    },
  },
  {
    id: 'gtk3',
    scope: 'desktop',
    platform: 'linux',
    why: 'GTK 3 — the window toolkit',
    probe: { kind: 'pkg-config', module: 'gtk+-3.0' },
    packages: { debian: 'libgtk-3-dev', fedora: 'gtk3-devel', arch: 'gtk3', suse: 'gtk3-devel' },
  },
  {
    id: 'libsoup3',
    scope: 'desktop',
    platform: 'linux',
    why: 'libsoup 3 — HTTP stack WebKitGTK 4.1 links against',
    probe: { kind: 'pkg-config', module: 'libsoup-3.0' },
    packages: {
      debian: 'libsoup-3.0-dev',
      fedora: 'libsoup3-devel',
      arch: 'libsoup3',
      suse: ['libsoup-3_0-devel', 'libsoup3-devel'], // TODO(suse): unverified; both spellings are plausible
    },
  },
  {
    id: 'glib',
    scope: 'desktop',
    platform: 'linux',
    // glib-2.0 and gobject-2.0 both come from this one package. There is no
    // `libgobject-2.0-dev` in Debian/Ubuntu — naming one is what makes an
    // otherwise-correct apt line fail as a whole.
    why: 'GLib/GObject 2 — base object system (provides both glib-2.0 and gobject-2.0)',
    probe: { kind: 'pkg-config', module: 'gobject-2.0' },
    packages: { debian: 'libglib2.0-dev', fedora: 'glib2-devel', arch: 'glib2', suse: 'glib2-devel' },
  },
  {
    id: 'cairo',
    scope: 'desktop',
    platform: 'linux',
    why: 'Cairo — 2D rendering',
    packages: {
      debian: 'libcairo2-dev',
      fedora: ['cairo-gobject-devel', 'cairo-devel'],
      arch: 'cairo',
      suse: 'cairo-devel',
    },
    probe: { kind: 'pkg-config', module: 'cairo' },
  },
  {
    id: 'pango',
    scope: 'desktop',
    platform: 'linux',
    why: 'Pango — text layout',
    probe: { kind: 'pkg-config', module: 'pango' },
    packages: { debian: 'libpango1.0-dev', fedora: 'pango-devel', arch: 'pango', suse: 'pango-devel' },
  },
  {
    id: 'atk',
    scope: 'desktop',
    platform: 'linux',
    why: 'ATK — accessibility toolkit GTK requires',
    probe: { kind: 'pkg-config', module: 'atk' },
    packages: { debian: 'libatk1.0-dev', fedora: 'atk-devel', arch: 'atk', suse: 'atk-devel' },
  },
  {
    id: 'dbus',
    scope: 'desktop',
    platform: 'linux',
    why: 'D-Bus — single-instance and OS notification transport',
    probe: { kind: 'pkg-config', module: 'dbus-1' },
    packages: { debian: 'libdbus-1-dev', fedora: 'dbus-devel', arch: 'dbus', suse: 'dbus-1-devel' },
  },
  {
    id: 'librsvg',
    scope: 'desktop',
    platform: 'linux',
    // The runtime librsvg2-2 is NOT enough: linuxdeploy-plugin-gtk shells out
    // to `pkg-config --variable=libdir librsvg-2.0`, so it needs the .pc file
    // from the -dev package. Without it tauri fails late with only
    // "failed to run linuxdeploy" and no cause.
    why: 'librsvg 2 (dev) — linuxdeploy-plugin-gtk reads its .pc file to find the SVG pixbuf loader',
    probe: { kind: 'pkg-config', module: 'librsvg-2.0' },
    // TODO(suse): `librsvg-devel` unverified.
    packages: { debian: 'librsvg2-dev', fedora: 'librsvg2-devel', arch: 'librsvg', suse: 'librsvg-devel' },
    bundleOnly: true,
  },
  {
    id: 'patchelf',
    scope: 'desktop',
    platform: 'linux',
    why: 'patchelf — rewrites RPATHs while bundling the AppImage',
    probe: { kind: 'command', command: 'patchelf' },
    packages: { debian: 'patchelf', fedora: 'patchelf', arch: 'patchelf', suse: 'patchelf' },
    bundleOnly: true,
  },
  {
    id: 'fuse2',
    scope: 'desktop',
    platform: 'linux',
    // Probe the soname, not a command or package: AppImages need the FUSE *2*
    // runtime, and every distro names it differently and has renamed it at
    // least once. Ubuntu's t64 transition moved libfuse2 -> libfuse2t64, and
    // the package now called `fuse` is FUSE 3, which does not satisfy this.
    why: 'FUSE 2 runtime — AppImages mount themselves through it',
    probe: { kind: 'soname', soname: 'libfuse.so.2' },
    packages: {
      debian: ['libfuse2t64', 'libfuse2'],
      fedora: 'fuse-libs',
      arch: 'fuse2',
      suse: 'libfuse2', // TODO(suse): unverified
    },
    bundleOnly: true,
  },
];

export function detectDistroFamily(osReleaseText) {
  if (!osReleaseText) return null;
  const field = (key) => {
    const m = osReleaseText.match(new RegExp(`^${key}=("?)(.*?)\\1$`, 'm'));
    return m ? m[2] : '';
  };
  const candidates = [field('ID'), ...field('ID_LIKE').split(/\s+/)].filter(Boolean);
  for (const candidate of candidates) {
    const hit = DISTRO_FAMILIES.find((f) => f.ids.some((id) => candidate.startsWith(id)));
    if (hit) return hit;
  }
  return null;
}

export function commandExists(command, { platform = process.platform, exec = execFileSync } = {}) {
  try {
    if (platform === 'win32') {
      exec('where.exe', [command], { stdio: 'ignore' });
    } else {
      exec('sh', ['-c', 'command -v "$1"', 'sh', command], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

function pkgConfigHas(module) {
  try {
    execFileSync('pkg-config', ['--exists', module], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sonameHas(soname) {
  try {
    const out = execFileSync('sh', ['-c', 'ldconfig -p 2>/dev/null || true'], { encoding: 'utf8' });
    return out.includes(soname);
  } catch {
    return false;
  }
}

export function runProbe(
  probe,
  env = process,
  { hasCommand = (command) => commandExists(command, { platform: env.platform }) } = {},
) {
  switch (probe.kind) {
    case 'node-major': {
      const major = Number.parseInt(String(env.versions?.node ?? '0').split('.')[0], 10);
      return { ok: Number.isFinite(major) && major >= probe.min, detail: `found v${env.versions?.node ?? '?'}` };
    }
    case 'command':
      return { ok: hasCommand(probe.command), detail: probe.command };
    case 'pkg-config':
      // Without pkg-config itself every module probe would report missing and
      // bury the one prerequisite that actually needs installing first.
      if (!hasCommand('pkg-config')) return { ok: false, detail: 'pkg-config unavailable', skipped: true };
      return { ok: pkgConfigHas(probe.module), detail: probe.module };
    case 'soname':
      return { ok: sonameHas(probe.soname), detail: probe.soname };
    default:
      throw new Error(`unknown probe kind: ${probe.kind}`);
  }
}

/**
 * Pick the package name to print. When archive verification is required, only
 * a confirmed candidate is safe for the combined install command. Other
 * families use their first recorded candidate when no archive lookup exists.
 */
export function resolvePackage(candidates, archiveHas, { requireArchive = false } = {}) {
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean);
  if (list.length === 0) return null;
  if (!archiveHas) return requireArchive ? null : list[0];
  return list.find((name) => archiveHas(name)) ?? null;
}

function aptArchiveHas(name) {
  try {
    const out = execFileSync('apt-cache', ['show', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /^Version:/m.test(out);
  } catch {
    return false;
  }
}

export function checkBuildPrereqs({
  scope = 'all',
  bundle = scope === 'all',
  platform = process.platform,
  family = null,
  dependencies = {},
} = {}) {
  const checkCommand = dependencies.commandExists ?? ((command) => commandExists(command, { platform }));
  const probe = dependencies.runProbe ?? ((value) => runProbe(value, process, { hasCommand: checkCommand }));

  const applicable = BUILD_PREREQS.filter((p) => {
    if (scope === 'web' && p.scope !== 'web') return false;
    if (scope === 'desktop' && !['web', 'desktop'].includes(p.scope)) return false;
    if (p.platform === 'linux' && platform !== 'linux') return false;
    if (p.bundleOnly && !bundle) return false;
    return true;
  });

  const archiveHas = dependencies.archiveHas !== undefined
    ? dependencies.archiveHas
    : family?.family === 'debian' && checkCommand('apt-cache')
      ? aptArchiveHas
      : null;
  const requireArchive = family?.family === 'debian';

  const results = applicable.map((prereq) => {
    const { ok, detail, skipped } = probe(prereq.probe);
    const pkg = family && prereq.packages && !skipped
      ? resolvePackage(prereq.packages[family.family], archiveHas, { requireArchive })
      : null;
    return { prereq, ok, detail, skipped, pkg };
  });

  return {
    results,
    missing: results.filter((result) => !result.ok && !result.skipped),
    blocked: results.filter((result) => result.skipped),
  };
}

function report(missing, blocked, family, scope) {
  console.error(`\n::error::build prereqs: ${missing.length} missing for scope "${scope}"\n`);
  for (const { prereq, detail } of missing) {
    console.error(`  ✗ ${prereq.id.padEnd(20)} ${prereq.why}`);
    console.error(`    ${' '.repeat(20)} probe: ${detail}${prereq.bundleOnly ? '  (bundling only)' : ''}`);
    if (prereq.hint) console.error(`    ${' '.repeat(20)} ${prereq.hint}`);
  }

  if (blocked.length > 0) {
    console.error('  Not checked because another prerequisite is unavailable:\n');
    for (const { prereq, detail } of blocked) {
      console.error(`  ? ${prereq.id.padEnd(20)} ${detail}`);
    }
    console.error('\n  Install the confirmed prerequisite above, then rerun this check.\n');
  }

  const packages = [...new Set(missing.map((m) => m.pkg).filter(Boolean))];
  if (packages.length > 0 && family) {
    console.error(`\n  Install on ${family.family}:\n\n    ${family.install} ${packages.join(' ')}\n`);
    if (UNVERIFIED_PACKAGE_FAMILIES.has(family.family)) {
      console.error(
        `  NOTE: these ${family.family} package names are unverified — they were derived from\n`
          + '  naming convention, not checked against a live archive. If one does not resolve,\n'
          + '  search for the package providing the pkg-config module named above.\n',
      );
    }
  } else if (!family) {
    console.error('\n  Unrecognized distribution — install the pkg-config modules listed above using your package manager.\n');
  } else if (family.family === 'debian' && missing.some((item) => item.prereq.packages && !item.pkg)) {
    console.error(
      '\n  Could not verify one or more Debian package names with apt-cache.\n'
        + '  Run `sudo apt-get update`, then rerun this check; no guessed combined install command was printed.\n',
    );
  }

  const toolchainOnly = missing.every((m) => !m.pkg);
  if (!toolchainOnly) {
    console.error('  Only needed for desktop workflows; `npm run build` (web) does not require these.\n');
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const argv = process.argv.slice(2);
  const scopeArg = argv.indexOf('--scope');
  const scope = scopeArg >= 0 ? argv[scopeArg + 1] : 'all';
  if (!['web', 'desktop', 'all'].includes(scope)) {
    console.error(`::error::build prereqs: unknown --scope "${scope}" (expected web, desktop, or all)`);
    process.exit(2);
  }
  const bundle = argv.includes('--bundle') || scope === 'all';

  let osRelease = '';
  try {
    osRelease = readFileSync('/etc/os-release', 'utf8');
  } catch {
    // Non-Linux or a container without os-release; family stays null and the
    // report degrades to capability names rather than failing.
  }
  const family = process.platform === 'linux' ? detectDistroFamily(osRelease) : null;

  const { results, missing, blocked } = checkBuildPrereqs({ scope, bundle, family });

  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      scope,
      bundle,
      family: family?.family ?? null,
      results: results.map((result) => ({
        id: result.prereq.id,
        ok: result.ok && !result.skipped,
        status: result.skipped ? 'blocked' : result.ok ? 'present' : 'missing',
        package: result.pkg,
      })),
    }, null, 2));
    process.exit(missing.length > 0 && !argv.includes('--warn-only') ? 1 : 0);
  }

  if (missing.length === 0) {
    console.log(`build prereqs OK (${scope}): ${results.length} checked`);
    process.exit(0);
  }

  report(missing, blocked, family, scope);
  if (argv.includes('--warn-only')) {
    console.error('  --warn-only: continuing despite missing prerequisites.\n');
    process.exit(0);
  }
  process.exit(1);
}
