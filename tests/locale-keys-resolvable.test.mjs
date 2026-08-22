// GUARD: every statically-quoted t('a.b.c') key used in src/components and
// src/app must resolve against src/locales/en.json.
//
// Resolution rules mirrored from runtime i18next behaviour:
//   - dotted lookup through nested objects
//   - leaf may be a string OR a plural family (`key_one` / `key_other`, …)
//     sitting next to the base name — e.g. code says t('x.signals', {count})
//     while en.json carries "signals_one"/"signals_other".
//
// Dynamically-composed keys (t(`panels.${id}.name`) fragments like "panels."
// or "commands.regions.") cannot be validated statically and are ignored:
// the scan only asserts on complete dotted literals ending in [a-zA-Z0-9_].
//
// Run: node --test tests/locale-keys-resolvable.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src/components', 'src/app'];
const PLURAL_SUFFIXES = ['_one', '_other', '_zero', '_two', '_few', '_many'];

function* walkTs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTs(p);
    else if (entry.name.endsWith('.ts')) yield p;
  }
}

function keyResolves(en, dotted) {
  const parts = dotted.split('.');
  let cur = en;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== 'object' || !(parts[i] in cur)) return false;
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (cur == null || typeof cur !== 'object') return false;
  const v = cur[last];
  if (typeof v === 'string') return true;
  // Plural family stored as flat siblings of the base name.
  return PLURAL_SUFFIXES.some((s) => typeof cur[`${last}${s}`] === 'string');
}

test('every static t() key resolves in en.json', () => {
  const en = JSON.parse(readFileSync(join(ROOT, 'src', 'locales', 'en.json'), 'utf8'));
  const literal = /\bt\(\s*(["'`])([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\1/g;
  const missing = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walkTs(join(ROOT, dir))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(literal)) {
        if (!keyResolves(en, m[2])) {
          missing.push(`${file.replace(join(ROOT), '')}: ${m[2]}`);
        }
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `t() keys that do not resolve in src/locales/en.json (add the key, or use\n` +
      `an existing one; plural families like key_one/key_next satisfy the check):\n` +
      missing.join('\n'),
  );
});

test('scanner self-check: known shapes are classified correctly', () => {
  const en = {
    a: { b: 'plain', signals_one: '{{count}} signal', signals_other: '{{count}} signals' },
    flat: 'title only',
  };
  assert.equal(keyResolves(en, 'a.b'), true);
  assert.equal(keyResolves(en, 'a.signals'), true); // plural family
  assert.equal(keyResolves(en, 'a.missing'), false);
  assert.equal(keyResolves(en, 'flat.nested'), false); // parent is a string
});
