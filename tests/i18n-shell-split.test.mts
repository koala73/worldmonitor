// Guards the en.json shell/rest split that backs PR #3535.
//
// 1. Round-trip parity: merging the committed en.shell.json + en.rest.json
//    must reproduce en.json exactly (no key drops, no shadow edits). If
//    a contributor edits en.json without re-running `npm run build:i18n-shell`,
//    this test fails — preventing prod from drifting from the source-of-truth
//    dictionary.
// 2. Disjoint partition: no top-level key (or `components.<sub>` key) appears
//    in both files. Catches accidental duplication that would let one side
//    silently override the other after a future i18next merge order change.
// 3. Shell size cap: the eagerly-imported shell stays under a hard byte
//    budget so future "just add it to the shell" PRs can't quietly
//    regress the bundle-weight win the issue calls out.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { partition, SHELL_TOP_LEVEL, SHELL_COMPONENTS_SUBKEYS } from '../scripts/build-i18n-shell.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const EN_PATH = path.join(REPO_ROOT, 'src/locales/en.json');
const SHELL_PATH = path.join(REPO_ROOT, 'src/locales/en.shell.json');
const REST_PATH = path.join(REPO_ROOT, 'src/locales/en.rest.json');

// 30KB raw-JSON cap. en.shell.json is currently ~25KB; the budget gives
// ~5KB of headroom for genuine new chrome strings while still keeping the
// shell in the "small" bucket the issue targets (<20KB after gzip).
const SHELL_BYTE_CAP = 30_000;

type Dict = Record<string, unknown>;

function loadJson(p: string): Dict {
  return JSON.parse(readFileSync(p, 'utf8')) as Dict;
}

function deepMerge(a: Dict, b: Dict): Dict {
  const out: Dict = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const existing = out[k];
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(existing as Dict, v as Dict);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function flatKeys(obj: Dict, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flatKeys(v as Dict, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

describe('i18n shell/rest split', () => {
  const en = loadJson(EN_PATH);
  const shell = loadJson(SHELL_PATH);
  const rest = loadJson(REST_PATH);

  it('committed shell/rest reproduces en.json when merged (no drift)', () => {
    const merged = deepMerge(shell, rest);
    assert.deepEqual(
      merged,
      en,
      'en.shell.json + en.rest.json no longer reconstructs en.json. Re-run `npm run build:i18n-shell`.',
    );
  });

  it('partition() output matches the committed split files', () => {
    const computed = partition(en);
    assert.deepEqual(
      computed.shell,
      shell,
      'Committed en.shell.json drifted from partition() output. Re-run `npm run build:i18n-shell`.',
    );
    assert.deepEqual(
      computed.rest,
      rest,
      'Committed en.rest.json drifted from partition() output. Re-run `npm run build:i18n-shell`.',
    );
  });

  it('shell and rest top-level keys are disjoint except for `components`', () => {
    const shellTops = new Set(Object.keys(shell));
    const restTops = new Set(Object.keys(rest));
    for (const k of shellTops) {
      if (k === 'components') continue;
      assert.equal(restTops.has(k), false, `top-level key "${k}" leaked into both shell and rest`);
    }
  });

  it('components subkeys are disjoint between shell and rest', () => {
    const shellSubs = new Set(Object.keys((shell.components as Dict | undefined) ?? {}));
    const restSubs = new Set(Object.keys((rest.components as Dict | undefined) ?? {}));
    for (const sub of shellSubs) {
      assert.equal(
        restSubs.has(sub),
        false,
        `components.${sub} appears in both shell and rest — partition is not disjoint`,
      );
    }
  });

  it('shell only contains the declared SHELL_TOP_LEVEL groups (+ components carve-out)', () => {
    for (const k of Object.keys(shell)) {
      const allowed = SHELL_TOP_LEVEL.has(k) || k === 'components';
      assert.equal(allowed, true, `unexpected top-level key "${k}" in en.shell.json`);
    }
    const shellComponents = (shell.components as Dict | undefined) ?? {};
    for (const sub of Object.keys(shellComponents)) {
      assert.equal(
        SHELL_COMPONENTS_SUBKEYS.has(sub),
        true,
        `unexpected components.${sub} in en.shell.json`,
      );
    }
  });

  it(`shell stays under the ${SHELL_BYTE_CAP}-byte raw-JSON cap`, () => {
    const bytes = Buffer.byteLength(JSON.stringify(shell), 'utf8');
    assert.ok(
      bytes < SHELL_BYTE_CAP,
      `en.shell.json grew to ${bytes} bytes, over the ${SHELL_BYTE_CAP}-byte cap. ` +
        'Move newly-added keys into en.rest.json or raise the cap with reasoning.',
    );
  });

  it('every leaf key in en.json resolves through the merged shell+rest', () => {
    const merged = deepMerge(shell, rest);
    const enLeaves = flatKeys(en);
    const mergedLeaves = new Set(flatKeys(merged));
    const missing = enLeaves.filter((k) => !mergedLeaves.has(k));
    assert.deepEqual(
      missing,
      [],
      `${missing.length} leaf keys missing from merged shell+rest: ${missing.slice(0, 5).join(', ')}`,
    );
  });

  it('REGRESSION (#3563 P1): shallow `{...shell, ...rest}` would clobber components — runtime merge MUST deep-merge components', () => {
    // Pins the gotcha that motivated the loadEnFull() fix in src/services/i18n.ts.
    // Both files have a top-level `components` key. A shallow spread drops the
    // shell's components.panel/deckgl/map. This test documents the trap so
    // future contributors don't "simplify" the runtime merge back to a shallow
    // spread.
    const shallow = { ...shell, ...rest } as Dict;
    const shallowComponents = (shallow.components as Dict | undefined) ?? {};
    assert.equal(
      'panel' in shallowComponents,
      false,
      'shallow spread should drop shell.components.panel (proves the bug exists)',
    );
    assert.equal(
      'deckgl' in shallowComponents,
      false,
      'shallow spread should drop shell.components.deckgl',
    );
    assert.equal(
      'map' in shallowComponents,
      false,
      'shallow spread should drop shell.components.map',
    );

    // The runtime fix: shallow spread plus an explicit components-level merge.
    const fixedComponents = {
      ...((shell.components as Dict | undefined) ?? {}),
      ...((rest.components as Dict | undefined) ?? {}),
    };
    const fixed: Dict = { ...shell, ...rest, components: fixedComponents };
    const fixedC = fixed.components as Dict;
    assert.ok('panel' in fixedC, 'runtime merge must preserve components.panel');
    assert.ok('deckgl' in fixedC, 'runtime merge must preserve components.deckgl');
    assert.ok('map' in fixedC, 'runtime merge must preserve components.map');
  });
});
