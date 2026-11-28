import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatConfigDriftFailure } from '../scripts/validate-rss-feeds.mjs';

describe('CI guardrail failure report', () => {
  it('names every failing feed with its URL and the full reason', () => {
    const reason = 'Host not in allowlist (--ci): feed.example.test';
    const text = formatConfigDriftFailure([
      { name: 'Asia-Plus', url: 'https://asiaplus.example/rss', detail: reason },
      { name: 'Korea Times', url: 'https://www.example.test/rss.xml', detail: 'Non-https scheme rejected in --ci mode: http:' },
    ]);

    assert.match(text, /^FAIL: 2 feed\(s\) violate the CI guardrails/);
    assert.match(text, /Asia-Plus \| Host not in allowlist \(--ci\): feed\.example\.test \| https:\/\/asiaplus\.example\/rss/);
    assert.match(text, /Korea Times \| Non-https scheme rejected in --ci mode: http: \| https:\/\/www\.example\.test\/rss\.xml/);
    assert.equal(text.includes('Host not in allowli…'), false);
  });
});
