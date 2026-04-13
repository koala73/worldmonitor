import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const digestSrc = readFileSync(
  resolve(__dirname, '../server/worldmonitor/news/v1/list-feed-digest.ts'),
  'utf-8',
);
const feedsSrc = readFileSync(
  resolve(__dirname, '../server/worldmonitor/news/v1/_feeds.ts'),
  'utf-8',
);
const classifierSrc = readFileSync(
  resolve(__dirname, '../server/worldmonitor/news/v1/_classifier.ts'),
  'utf-8',
);
const relaySrc = readFileSync(
  resolve(__dirname, '../scripts/ais-relay.cjs'),
  'utf-8',
);

describe('sports digest guardrails', () => {
  it('accepts sports as a valid digest variant', () => {
    assert.match(
      digestSrc,
      /VALID_VARIANTS\s*=\s*new Set\(\['full', 'tech', 'finance', 'happy', 'commodity', 'sports'\]\)/,
    );
  });

  it('defines a dedicated sports feed registry on the server', () => {
    assert.match(feedsSrc, /\bsports:\s*\{/);
    for (const category of ['sports', 'soccer', 'basketball', 'baseball', 'motorsport', 'tennis', 'combat']) {
      assert.match(feedsSrc, new RegExp(`\\b${category}:\\s*\\[`), `missing sports category ${category}`);
    }
  });

  it('keeps server-side sports digest headlines on the low-signal classification path', () => {
    assert.match(
      classifierSrc,
      /if \(variant === 'sports'\)\s*\{\s*return \{ level: 'info', category: 'general', confidence: 0\.15, source: 'keyword' \};\s*\}/,
    );
  });

  it('does not add sports to the relay threat classification seeder', () => {
    assert.match(
      relaySrc,
      /CLASSIFY_VARIANTS = \['full', 'tech', 'finance', 'happy', 'commodity'\]/,
    );
  });
});
