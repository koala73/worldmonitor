import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_CATALOG } from '../scripts/check-live-video-sources.mjs';
import { MAX_REFRESH_CHANNELS, refreshChannels } from '../scripts/lib/live-video-refresh.mjs';
import { REFRESH_CHANNELS_FILE, renderRefreshChannels, runSync } from '../scripts/sync-live-video-refresh-channels.mjs';

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const committedText = readFileSync(REFRESH_CHANNELS_FILE, 'utf8');
const committed = JSON.parse(committedText) as { generatedFrom: string; channels: Array<{ channelId: string; slots: string[] }> };

describe('scripts/shared/live-video-refresh-channels.generated.json', () => {
  it('equals the catalog (run npm run sync:live-video-channels after editing a channel entry)', () => {
    assert.equal(committedText, renderRefreshChannels(DEFAULT_CATALOG));
    assert.deepEqual(committed.channels, refreshChannels(DEFAULT_CATALOG));
    assert.equal(committed.generatedFrom, 'src/config/live-video-sources.ts');
  });

  it('lists only catalog slots, never a canary on its own', () => {
    const slotNames = new Set([
      ...Object.keys(DEFAULT_CATALOG.webcams).map((id) => `webcams/${id}`),
      ...Object.keys(DEFAULT_CATALOG.news).map((id) => `live-news/${id}`),
    ]);
    for (const { channelId, slots } of committed.channels) {
      assert.match(channelId, CHANNEL_ID);
      assert.ok(slots.length > 0, `${channelId} lists no slot`);
      for (const slot of slots) {
        assert.ok(!slot.startsWith('canary/'), `${channelId} carries canary marker ${slot}`);
        assert.ok(slotNames.has(slot), `${channelId} names ${slot}, which is not a catalog slot`);
      }
    }
  });

  it('stays within the channel cap, one entry per channel', () => {
    const ids = committed.channels.map((entry) => entry.channelId);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length > 0);
    assert.ok(ids.length <= MAX_REFRESH_CHANNELS, `${ids.length} channels, cap ${MAX_REFRESH_CHANNELS}`);
  });
});

describe('sync-live-video-refresh-channels --check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-video-channels-'));
  const run = (text: string) => {
    const file = join(dir, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, text);
    const errors: string[] = [];
    const code = runSync({ check: true, file, catalog: DEFAULT_CATALOG, error: (line: string) => errors.push(line) });
    return { code, errors: errors.join('\n') };
  };

  it('passes on the generated text', () => {
    assert.deepEqual(run(renderRefreshChannels(DEFAULT_CATALOG)), { code: 0, errors: '' });
  });

  it('fails and names the channel when one is missing', () => {
    const removed = committed.channels[0]!;
    const text = `${JSON.stringify({ ...committed, channels: committed.channels.slice(1) }, null, 2)}\n`;
    const { code, errors } = run(text);
    assert.equal(code, 1);
    assert.match(errors, /is stale/);
    assert.ok(errors.includes(`missing ${removed.channelId}`), errors);
  });

  it('fails on a channel the catalog no longer lists, and on a missing file', () => {
    const extra = { channelId: `UC${'x'.repeat(22)}`, slots: ['live-news/gone'] };
    const { code, errors } = run(`${JSON.stringify({ ...committed, channels: [...committed.channels, extra] }, null, 2)}\n`);
    assert.equal(code, 1);
    assert.ok(errors.includes(`not in the catalog: ${extra.channelId}`), errors);
    assert.equal(runSync({ check: true, file: join(dir, 'absent.json'), catalog: DEFAULT_CATALOG, error: () => {} }), 1);
  });
});
