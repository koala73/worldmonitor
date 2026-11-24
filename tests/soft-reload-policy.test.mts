import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CLIENT_COMPAT } from '../src/bootstrap/client-compat.ts';
import {
  SOFT_RELOAD_MIN_PAGE_AGE_MS,
  _resetAudibleMediaForTests,
  currentSoftReloadHold,
  isAudibleMediaPlaying,
  setAudibleMedia,
  softReloadHold,
} from '../src/bootstrap/soft-reload-policy.ts';

const QUIET = { visibilityState: 'hidden', pageAgeMs: SOFT_RELOAD_MIN_PAGE_AGE_MS, audibleMedia: false } as const;

describe('softReloadHold', () => {
  it('lets a hidden, silent, long-open tab reload', () => {
    assert.equal(softReloadHold(QUIET), null);
  });

  it('holds a visible tab', () => {
    assert.equal(softReloadHold({ ...QUIET, visibilityState: 'visible' }), 'visible');
  });

  it('holds when visibility is unknown or prerendering, since only hidden is safe', () => {
    assert.equal(softReloadHold({ ...QUIET, visibilityState: undefined }), 'visible');
    assert.equal(softReloadHold({ ...QUIET, visibilityState: 'prerender' }), 'visible');
  });

  it('holds while media plays with sound', () => {
    assert.equal(softReloadHold({ ...QUIET, audibleMedia: true }), 'audible-media');
  });

  it('holds a page younger than the minimum age, and releases it exactly at the minimum', () => {
    assert.equal(softReloadHold({ ...QUIET, pageAgeMs: SOFT_RELOAD_MIN_PAGE_AGE_MS - 1 }), 'recently-loaded');
    assert.equal(softReloadHold({ ...QUIET, pageAgeMs: SOFT_RELOAD_MIN_PAGE_AGE_MS }), null);
  });

  it('holds when the page age is not a number', () => {
    assert.equal(softReloadHold({ ...QUIET, pageAgeMs: Number.NaN }), 'recently-loaded');
  });

  it('caps a tab at a handful of such reloads a day', () => {
    assert.ok(SOFT_RELOAD_MIN_PAGE_AGE_MS >= 60 * 60_000, 'a shorter window brings back a reload per deploy');
  });
});

describe('audible media registry', () => {
  beforeEach(() => _resetAudibleMediaForTests());

  it('is audible while any source is, and silent once all have stopped', () => {
    assert.equal(isAudibleMediaPlaying(), false);
    setAudibleMedia('live-news', true);
    setAudibleMedia('other', true);
    setAudibleMedia('live-news', false);
    assert.equal(isAudibleMediaPlaying(), true);
    setAudibleMedia('other', false);
    assert.equal(isAudibleMediaPlaying(), false);
  });

  it('feeds the live decision', () => {
    setAudibleMedia('live-news', true);
    assert.equal(currentSoftReloadHold({ visibilityState: 'hidden' }), 'audible-media');
  });

  it('counts native video or audio playing with sound, which no panel has to register', () => {
    const media = (state: Partial<{ paused: boolean; ended: boolean; muted: boolean; volume: number }>) =>
      ({ paused: false, ended: false, muted: false, volume: 1, ...state });
    const docWith = (...elements: unknown[]) => ({
      visibilityState: 'hidden',
      querySelectorAll: (selector: string) => (selector === 'video, audio' ? elements : []),
    });
    assert.equal(currentSoftReloadHold(docWith(media({}))), 'audible-media');
    assert.equal(currentSoftReloadHold(docWith(media({ muted: true }), media({ paused: true }))), 'recently-loaded');
    assert.equal(currentSoftReloadHold(docWith(media({ volume: 0 }), media({ ended: true }))), 'recently-loaded');
    assert.equal(currentSoftReloadHold(docWith(media({ muted: true }), media({}))), 'audible-media');
  });

  it('a document that cannot be queried is not treated as audible', () => {
    const doc = { visibilityState: 'hidden', querySelectorAll: () => { throw new Error('detached'); } };
    assert.equal(currentSoftReloadHold(doc), 'recently-loaded');
  });

  it('a freshly started process counts as a recently loaded page', () => {
    assert.equal(currentSoftReloadHold({ visibilityState: 'hidden' }), 'recently-loaded');
  });
});

describe('client compatibility marker', () => {
  it('has the shape the reader accepts', () => {
    // stale-bundle-check treats any other shape as "no marker" and force-reloads every tab.
    assert.match(CLIENT_COMPAT, /^[A-Za-z0-9._-]{1,32}$/);
  });

  it('is published by the build as /client-compat.txt from the same constant', () => {
    const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    assert.match(viteConfig, /import \{ CLIENT_COMPAT \} from '\.\/src\/bootstrap\/client-compat';/);
    // Marker, then the build it belongs to, so a reader can tell which deploy answered.
    assert.match(viteConfig, /fileName: 'client-compat\.txt',\s*source: `\$\{CLIENT_COMPAT\}\\n\$\{BUILD_SHA\}\\n`,/);
    assert.match(viteConfig, /fileName: 'build-hash\.txt',\s*source: BUILD_SHA,/);
  });

  it('a marker change reaches production: the deploy filter builds on src/ and vite.config.ts', () => {
    const ignore = readFileSync(new URL('../scripts/vercel-ignore.sh', import.meta.url), 'utf8');
    assert.match(ignore, /'src\/'/);
    assert.match(ignore, /'vite\.config\.ts'/);
  });
});
