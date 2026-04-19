// Regression tests for middleware.ts's bot-UA gate.
//
// Pins the contract around the `/api/brief/carousel/` carve-out
// shipped in PR #3196: social-platform image fetchers
// (Slack/Telegram/Discord/LinkedIn/etc.) must be able to download
// the carousel PNGs even though their UAs contain "bot" and thus
// match BOT_UA, while the generic bot gate must still 403 plain
// scrapers on every other API path.
//
// Without this test the allowlist is the kind of policy that
// silently regresses on future middleware edits — Telegram's
// sendMediaGroup failure mode ("WEBPAGE_CURL_FAILED") does not
// surface as a CI failure anywhere else.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import middleware from '../middleware';

const TELEGRAM_BOT_UA = 'TelegramBot (like TwitterBot)';
const SLACKBOT_UA = 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)';
const DISCORDBOT_UA = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const LINKEDINBOT_UA = 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)';
const GENERIC_CURL_UA = 'curl/8.1.2';
const GENERIC_SCRAPER_UA = 'Mozilla/5.0 (compatible; SomeRandomBot/1.2)';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CAROUSEL_PATH = '/api/brief/carousel/user_abc/2026-04-19/0';
const OTHER_API_PATH = '/api/notifications';
const MALFORMED_CAROUSEL_PATH = '/api/brief/carousel/admin/dashboard';

function call(pathOrUrl: string, ua: string): Response | void {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `https://www.worldmonitor.app${pathOrUrl}`;
  const req = new Request(url, {
    headers: ua ? { 'user-agent': ua } : {},
  });
  return middleware(req) as Response | void;
}

describe('middleware bot gate / carousel allowlist', () => {
  it('passes TelegramBot through on the carousel route (the PR #3196 fix)', () => {
    const res = call(CAROUSEL_PATH, TELEGRAM_BOT_UA);
    assert.equal(res, undefined, 'Telegram must be able to fetch carousel images');
  });

  it('passes Slackbot through on the carousel route', () => {
    const res = call(CAROUSEL_PATH, SLACKBOT_UA);
    assert.equal(res, undefined);
  });

  it('passes Discordbot through on the carousel route', () => {
    const res = call(CAROUSEL_PATH, DISCORDBOT_UA);
    assert.equal(res, undefined);
  });

  it('passes LinkedInBot through on the carousel route', () => {
    const res = call(CAROUSEL_PATH, LINKEDINBOT_UA);
    assert.equal(res, undefined);
  });

  it('still 403s curl on the carousel route (bot gate protects from non-social UAs)', () => {
    const res = call(CAROUSEL_PATH, GENERIC_CURL_UA);
    assert.ok(res instanceof Response, 'should return a Response, not pass through');
    assert.equal(res.status, 403);
  });

  it('still 403s a generic "bot" UA on the carousel route', () => {
    const res = call(CAROUSEL_PATH, GENERIC_SCRAPER_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('still 403s TelegramBot on non-carousel API routes (allowlist is scoped, not global)', () => {
    const res = call(OTHER_API_PATH, TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('still 403s TelegramBot on malformed carousel paths (regex enforces route shape)', () => {
    const res = call(MALFORMED_CAROUSEL_PATH, TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('still 403s missing UA on the carousel route (short-UA guard)', () => {
    const res = call(CAROUSEL_PATH, '');
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });

  it('passes normal browsers through on the carousel route', () => {
    const res = call(CAROUSEL_PATH, CHROME_UA);
    assert.equal(res, undefined);
  });

  it('passes normal browsers through on any API route', () => {
    const res = call(OTHER_API_PATH, CHROME_UA);
    assert.equal(res, undefined);
  });

  it('does not accept page 3+ on the carousel route (pageFromIndex only has 0/1/2)', () => {
    const res = call('/api/brief/carousel/user_abc/2026-04-19/3', TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response, 'out-of-range page must hit the bot gate');
    assert.equal(res.status, 403);
  });

  it('does not accept non-ISO-date segments on the carousel route', () => {
    const res = call('/api/brief/carousel/user_abc/today/0', TELEGRAM_BOT_UA);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });
});
