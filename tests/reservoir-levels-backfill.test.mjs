import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleBaseline, ensurePrivateScratchDir } from '../scripts/backfill-reservoir-levels.mjs';

const ENTRY = { id: 'mead', core: [-114.8, 36.0, -114.4, 36.3], refid: 2310000809 };

function scratch(dir, s, file = `${s.id}.json`) {
  writeFileSync(join(dir, file), JSON.stringify({
    id: 'mead', core: ENTRY.core, refid: ENTRY.refid,
    granules: [], processed: [], failures: {}, done: true, processedThrough: '2026-09-06',
    passes: [['2026-09-06T10:00Z', 1, 316.757, 0.02, 40, 0.03]], ...s,
  }));
}

describe('baseline assembly', () => {
  it('assembles a scratch file built for the committed watchlist entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reservoir-backfill-'));
    try {
      scratch(dir, { id: 'mead' });
      const b = assembleBaseline([ENTRY], dir, '2026-11-11T00:00:00Z');
      assert.equal(b.reservoirs.mead.passes.length, 1);
      assert.equal(b.through, '2026-09-06');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses scratch built for a different core box', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reservoir-backfill-'));
    try {
      scratch(dir, { id: 'mead', core: [-115, 35.9, -114, 36.5] });
      assert.throws(() => assembleBaseline([ENTRY], dir), /different core box/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses scratch built for a different refid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reservoir-backfill-'));
    try {
      scratch(dir, { id: 'mead', refid: 42 });
      assert.throws(() => assembleBaseline([ENTRY], dir), /different core box or refid/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a scratch file labelled with another id', () => {
    // The scratch id drives later writes; a planted "../x" must never become a path.
    const dir = mkdtempSync(join(tmpdir(), 'reservoir-backfill-'));
    try {
      scratch(dir, { id: '../outside/planted' }, 'mead.json');
      assert.throws(() => assembleBaseline([ENTRY], dir), /labelled/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a reservoir id that is not a plain slug', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reservoir-backfill-'));
    try {
      assert.throws(() => assembleBaseline([{ ...ENTRY, id: '../mead' }], dir), /unsafe reservoir id/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('scratch directory', () => {
  it('creates the directory readable only by its owner', () => {
    const parent = mkdtempSync(join(tmpdir(), 'reservoir-scratch-'));
    try {
      const dir = join(parent, 'scratch');
      ensurePrivateScratchDir(dir);
      assert.ok(existsSync(dir));
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('tightens an existing directory that other users could write', () => {
    const parent = mkdtempSync(join(tmpdir(), 'reservoir-scratch-'));
    try {
      const dir = join(parent, 'scratch');
      mkdirSync(dir);
      chmodSync(dir, 0o777);
      ensurePrivateScratchDir(dir);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('refuses a symlink in place of the directory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'reservoir-scratch-'));
    try {
      const target = join(parent, 'elsewhere');
      mkdirSync(target);
      const dir = join(parent, 'scratch');
      symlinkSync(target, dir);
      assert.throws(() => ensurePrivateScratchDir(dir), /not a plain directory/);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});
