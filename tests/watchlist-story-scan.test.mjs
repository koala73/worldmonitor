/**
 * Behavioral coverage for the watchlist story alert scan/publish orchestration.
 *
 * Run: node --test tests/watchlist-story-scan.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildTickerDictionary } from '../shared/ticker-extract.js';
import {
  publishWatchlistNotificationEvent,
  scanAndEnqueueWatchlistStoryEvents,
  WATCHLIST_SCAN_DEDUP_TTL_SECONDS,
} from '../scripts/lib/watchlist-story-scan.mjs';

const silentLogger = { log() {}, warn() {} };

const event = {
  eventType: 'watchlist_story_alert',
  severity: 'high',
  payload: {
    title: 'Microsoft faces new antitrust probe',
    link: 'https://example.test/msft',
    source: 'Example Wire',
    tickers: ['MSFT'],
    importanceScore: 74,
    coalesceKey: 'watchlist:h1',
  },
};

function flatTrack(overrides) {
  return Object.entries({
    title: 'Microsoft faces new antitrust probe',
    description: '',
    link: 'https://example.test/msft',
    currentScore: '74',
    ...overrides,
  }).flat();
}

describe('publishWatchlistNotificationEvent', () => {
  it('runs SET NX before LPUSH and stamps the queued event', async () => {
    const calls = [];
    const upstashRest = async (...args) => {
      calls.push(args);
      if (args[0] === 'SET') return 'OK';
      if (args[0] === 'LPUSH') return 1;
      throw new Error(`unexpected command ${args[0]}`);
    };

    assert.equal(
      await publishWatchlistNotificationEvent(event, { upstashRest, nowMs: () => 1234, logger: silentLogger }),
      true,
    );

    assert.equal(calls[0][0], 'SET');
    assert.match(calls[0][1], /^wm:notif:scan-dedup:watchlist_story_alert:/);
    assert.deepEqual(calls[0].slice(2), ['1', 'NX', 'EX', String(WATCHLIST_SCAN_DEDUP_TTL_SECONDS)]);
    assert.equal(calls[1][0], 'LPUSH');
    assert.equal(calls[1][1], 'wm:events:queue');
    assert.deepEqual(JSON.parse(calls[1][2]), { ...event, publishedAt: 1234 });
  });

  it('treats a non-new SET NX result as a duplicate and does not LPUSH', async () => {
    const calls = [];
    const upstashRest = async (...args) => {
      calls.push(args);
      return null;
    };

    assert.equal(await publishWatchlistNotificationEvent(event, { upstashRest, logger: silentLogger }), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'SET');
  });

  it('rolls back the dedup key when LPUSH returns a non-numeric result', async () => {
    const calls = [];
    const upstashRest = async (...args) => {
      calls.push(args);
      if (args[0] === 'SET') return 'OK';
      if (args[0] === 'LPUSH') return 'ERR';
      if (args[0] === 'DEL') return 1;
      throw new Error(`unexpected command ${args[0]}`);
    };

    assert.equal(await publishWatchlistNotificationEvent(event, { upstashRest, logger: silentLogger }), false);
    assert.deepEqual(calls.map((call) => call[0]), ['SET', 'LPUSH', 'DEL']);
    assert.equal(calls[2][1], calls[0][1], 'rollback must delete the SET NX dedup key');
  });

  it('rolls back the dedup key when LPUSH throws', async () => {
    const calls = [];
    const upstashRest = async (...args) => {
      calls.push(args);
      if (args[0] === 'SET') return 'OK';
      if (args[0] === 'LPUSH') throw new Error('timeout');
      if (args[0] === 'DEL') return 1;
      throw new Error(`unexpected command ${args[0]}`);
    };

    assert.equal(await publishWatchlistNotificationEvent(event, { upstashRest, logger: silentLogger }), false);
    assert.deepEqual(calls.map((call) => call[0]), ['SET', 'LPUSH', 'DEL']);
    assert.equal(calls[2][1], calls[0][1], 'rollback must delete the SET NX dedup key');
  });
});

describe('scanAndEnqueueWatchlistStoryEvents', () => {
  const dictionary = buildTickerDictionary([
    { symbol: 'MSFT', name: 'Microsoft' },
    { symbol: 'LLY', name: 'Eli Lilly' },
  ]);

  it('dedupes accumulator hashes, reads tracks, hydrates sources, gates by score, then publishes', async () => {
    const order = [];
    const queued = [];
    const pipelineCalls = [];
    const trackReads = [];

    const upstashRest = async (...args) => {
      order.push(args[0]);
      if (args[0] === 'ZRANGEBYSCORE') {
        return args[1].includes(':full:') ? ['h1', 'low'] : ['h1', 'h2'];
      }
      if (args[0] === 'SET') return 'OK';
      if (args[0] === 'LPUSH') {
        queued.push(JSON.parse(args[2]));
        return 1;
      }
      throw new Error(`unexpected command ${args[0]}`);
    };
    const upstashPipeline = async (commands) => {
      order.push('SMEMBERS');
      pipelineCalls.push(commands);
      return commands.map((cmd) => ({ result: [cmd[1].endsWith(':h1') ? 'Reuters' : 'Other Wire'] }));
    };
    const readStoryTracksChunked = async (hashes, pipeline) => {
      order.push('track-read');
      trackReads.push({ hashes, samePipeline: pipeline === upstashPipeline });
      return hashes.map((hash) => {
        if (hash === 'h1') return { result: flatTrack({ title: 'Microsoft antitrust probe', currentScore: '74' }) };
        if (hash === 'low') return { result: flatTrack({ title: 'Microsoft shares slip', currentScore: '68' }) };
        return { result: flatTrack({ title: 'Earthquake strikes region', currentScore: '95' }) };
      });
    };

    const result = await scanAndEnqueueWatchlistStoryEvents(10_000, {
      env: { WATCHLIST_STORY_SCORE_MIN: '69' },
      upstashRest,
      upstashPipeline,
      readStoryTracksChunked,
      tickerDictionary: dictionary,
      logger: silentLogger,
    });

    assert.deepEqual(result, { hashes: 3, candidates: 2, events: 1, enqueued: 1, scoreMin: 69 });
    assert.deepEqual(order, ['ZRANGEBYSCORE', 'ZRANGEBYSCORE', 'track-read', 'SMEMBERS', 'SET', 'LPUSH']);
    assert.deepEqual(trackReads, [{ hashes: ['h1', 'low', 'h2'], samePipeline: true }]);
    assert.deepEqual(pipelineCalls, [[['SMEMBERS', 'story:sources:v1:h1']]]);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].eventType, 'watchlist_story_alert');
    assert.deepEqual(queued[0].payload.tickers, ['MSFT']);
    assert.equal(queued[0].payload.source, 'Reuters');
  });

  it('does not publish when the importance threshold filters out ticker matches', async () => {
    const commands = [];
    const upstashRest = async (...args) => {
      commands.push(args[0]);
      if (args[0] === 'ZRANGEBYSCORE') return ['h1'];
      throw new Error(`unexpected command ${args[0]}`);
    };
    const upstashPipeline = async () => {
      commands.push('SMEMBERS');
      return [{ result: ['Reuters'] }];
    };
    const readStoryTracksChunked = async () => [{ result: flatTrack({ currentScore: '74' }) }];

    const result = await scanAndEnqueueWatchlistStoryEvents(10_000, {
      env: { WATCHLIST_STORY_SCORE_MIN: '80' },
      upstashRest,
      upstashPipeline,
      readStoryTracksChunked,
      tickerDictionary: dictionary,
      logger: silentLogger,
    });

    assert.deepEqual(result, { hashes: 1, candidates: 0, events: 0, enqueued: 0, scoreMin: 80 });
    assert.deepEqual(commands, ['ZRANGEBYSCORE', 'ZRANGEBYSCORE']);
  });
});
