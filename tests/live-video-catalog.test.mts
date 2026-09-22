import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { AUDIT_CANARIES, LIVE_NEWS_SOURCES, WEBCAM_GRID_PRIORITY, WEBCAM_SOURCES } from '../src/config/live-video-sources.ts';
import { parseSourceEntry, type Candidate } from '../src/services/live-video/model.ts';

const webcamsPanel = readFileSync(new URL('../src/components/LiveWebcamsPanel.ts', import.meta.url), 'utf8');
const feedIds = [...webcamsPanel.matchAll(/\{\s*id:\s*'([^']+)',\s*city:/g)].map((match) => match[1]!);

// The built-in Live News channel list lives in src/services/live-channels.ts (#8293); the panel only plays it.
const newsChannels = readFileSync(new URL('../src/services/live-channels.ts', import.meta.url), 'utf8')
  + readFileSync(new URL('../src/components/LiveNewsPanel.ts', import.meta.url), 'utf8');
function newsChannelIds(arrayName: string): string[] {
  const body = newsChannels.match(new RegExp(`const ${arrayName}[^=]*=[^\\[]*\\[([\\s\\S]*?)\\n\\];`))?.[1] ?? '';
  return [...body.matchAll(/\{\s*id:\s*'([^']+)',\s*name:/g)].map((match) => match[1]!);
}
const defaultNewsIds = [...newsChannelIds('FULL_LIVE_CHANNELS'), ...newsChannelIds('TECH_LIVE_CHANNELS')];
const builtinNewsIds = new Set([...defaultNewsIds, ...newsChannelIds('OPTIONAL_LIVE_CHANNELS')]);

// Streams deliberately shared by two Live News channels. Anything else repeated is a paste mistake.
const SHARED_NEWS_STREAMS = new Map([['video:HvZt-nh9sGg', ['france24', 'france24-en']]]);

function identity(candidate: Candidate): string {
  if (candidate.kind === 'video') return `video:${candidate.videoId}`;
  if (candidate.kind === 'channel') return `channel:${candidate.channelId}`;
  return `hls:${candidate.url}`;
}

describe('live video catalog', () => {
  it('parses every webcam entry', () => {
    for (const [slot, entries] of Object.entries(WEBCAM_SOURCES)) {
      for (const entry of entries) {
        const parsed = parseSourceEntry(entry);
        assert.ok(parsed.ok, `webcams/${slot}: ${entry} is not a valid entry (${parsed.ok ? '' : parsed.problem})`);
      }
    }
  });

  it('never lists the same stream in two webcam slots', () => {
    const seen = new Map<string, string>();
    for (const [slot, entries] of Object.entries(WEBCAM_SOURCES)) {
      for (const entry of entries) {
        const parsed = parseSourceEntry(entry);
        if (!parsed.ok) continue;
        const key = identity(parsed.candidate);
        assert.equal(seen.get(key), undefined, `webcams/${slot} repeats ${entry} from webcams/${seen.get(key)}; point one slot at the stream instead`);
        seen.set(key, slot);
      }
    }
  });

  it('has exactly one catalog slot per webcam feed', () => {
    assert.ok(feedIds.length > 0, 'no WEBCAM_FEEDS ids found in LiveWebcamsPanel.ts');
    assert.deepEqual([...feedIds].sort(), Object.keys(WEBCAM_SOURCES).sort());
  });

  it('orders the default wall by slots that exist, once each', () => {
    for (const id of WEBCAM_GRID_PRIORITY) assert.ok(id in WEBCAM_SOURCES, `WEBCAM_GRID_PRIORITY names unknown slot ${id}`);
    assert.equal(new Set(WEBCAM_GRID_PRIORITY).size, WEBCAM_GRID_PRIORITY.length);
  });

  // Which slots open the wall is the owner's call: emptying a dead slot moves the next one up.
  it('has enough filled priority slots to open a full default wall', () => {
    const filled = WEBCAM_GRID_PRIORITY.filter((id) => WEBCAM_SOURCES[id].length > 0);
    assert.ok(filled.length >= 4, `the default wall shows the first four WEBCAM_GRID_PRIORITY slots with entries; only ${filled.length} have any (${filled.join(', ')})`);
  });

  it('parses every Live News entry as an https stream, a video or a channel', () => {
    for (const [slot, entries] of Object.entries(LIVE_NEWS_SOURCES)) {
      for (const entry of entries) {
        const parsed = parseSourceEntry(entry);
        assert.ok(parsed.ok, `live-news/${slot}: ${entry} is not a valid entry (${parsed.ok ? '' : parsed.problem})`);
      }
    }
  });

  it('never lists the same stream in two Live News channels unless the pair is declared', () => {
    const seen = new Map<string, string[]>();
    for (const [slot, entries] of Object.entries(LIVE_NEWS_SOURCES)) {
      for (const entry of entries) {
        const parsed = parseSourceEntry(entry);
        if (!parsed.ok) continue;
        const key = identity(parsed.candidate);
        seen.set(key, [...(seen.get(key) ?? []), slot]);
      }
    }
    for (const [key, slots] of seen) {
      if (slots.length < 2) continue;
      assert.deepEqual(slots, SHARED_NEWS_STREAMS.get(key), `${key} is listed in live-news/${slots.join(' and live-news/')}; point one channel at the stream instead`);
    }
  });

  it('has exactly one catalog slot per built-in Live News channel', () => {
    assert.ok(builtinNewsIds.size > 50, 'no Live News channel ids found in src/services/live-channels.ts');
    assert.deepEqual([...builtinNewsIds].sort(), Object.keys(LIVE_NEWS_SOURCES).sort());
  });

  it('does not list CNBC, whose only YouTube live stream is a documentary marathon', () => {
    assert.equal('cnbc' in LIVE_NEWS_SOURCES, false, 'cnbc must not have a Live News catalog slot');
    assert.doesNotMatch(readFileSync(new URL('../src/config/live-video-sources.ts', import.meta.url), 'utf8'), /\bcnbc\b/i);
  });

  it('gives every default Live News channel at least one entry', () => {
    for (const id of defaultNewsIds) {
      assert.ok((LIVE_NEWS_SOURCES as Record<string, readonly string[]>)[id]?.length, `default channel live-news/${id} has no entries`);
    }
  });

  it('keeps stream addresses out of the Live News channel list and panel', () => {
    assert.doesNotMatch(newsChannels, /\.m3u8/, 'HLS stream URLs belong in src/config/live-video-sources.ts');
    assert.doesNotMatch(newsChannels, /fallbackVideoId:\s*'/, 'video ids belong in src/config/live-video-sources.ts');
  });

  it('never plays a slate clip as a live channel', () => {
    // CNN's cnn_slate playlist is a ~10-minute VOD (#EXT-X-ENDLIST) that played under a LIVE label.
    const slates = Object.entries(LIVE_NEWS_SOURCES).filter(([, entries]) => entries.some((entry) => /cnn_slate|[/_-]slate[/_.-]/i.test(entry)));
    assert.deepEqual(slates, []);
  });

  it('uses channel live embeds as audit canaries', () => {
    assert.equal(AUDIT_CANARIES.length, 2);
    for (const entry of AUDIT_CANARIES) {
      const parsed = parseSourceEntry(entry);
      assert.ok(parsed.ok && parsed.candidate.kind === 'channel', `${entry} must be a channel URL`);
    }
  });
});
