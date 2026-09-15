import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { AUDIT_CANARIES, WEBCAM_GRID_PRIORITY, WEBCAM_SOURCES } from '../src/config/live-video-sources.ts';
import { parseSourceEntry, type Candidate } from '../src/services/live-video/model.ts';

const webcamsPanel = readFileSync(new URL('../src/components/LiveWebcamsPanel.ts', import.meta.url), 'utf8');
const feedIds = [...webcamsPanel.matchAll(/\{\s*id:\s*'([^']+)',\s*city:/g)].map((match) => match[1]!);

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

  it('uses channel live embeds as audit canaries', () => {
    assert.equal(AUDIT_CANARIES.length, 2);
    for (const entry of AUDIT_CANARIES) {
      const parsed = parseSourceEntry(entry);
      assert.ok(parsed.ok && parsed.candidate.kind === 'channel', `${entry} must be a channel URL`);
    }
  });
});
