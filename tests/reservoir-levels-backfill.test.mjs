import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleBaseline } from '../scripts/backfill-reservoir-levels.mjs';

const ENTRY = { id: 'mead', core: [-114.8, 36.0, -114.4, 36.3], refid: 2310000809 };

function scratch(dir, s) {
  writeFileSync(join(dir, `${s.id}.json`), JSON.stringify({
    id: 'mead', core: ENTRY.core, refid: ENTRY.refid, product: 'atl13', levelWindowM: null,
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

  it('refuses scratch left by an ATL06 cross-check run for a real reservoir id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reservoir-backfill-'));
    try {
      scratch(dir, { id: 'mead', product: 'atl06' });
      assert.throws(() => assembleBaseline([ENTRY], dir), /different core box, refid, product or level window/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses scratch built for a different core box', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reservoir-backfill-'));
    try {
      scratch(dir, { id: 'mead', core: [-115, 35.9, -114, 36.5] });
      assert.throws(() => assembleBaseline([ENTRY], dir), /different core box/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
