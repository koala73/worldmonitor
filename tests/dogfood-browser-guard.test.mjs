import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isProductUrl, refusal } from '../scripts/dogfood/browser-guard.mjs';

const s = (...args) => ['--session', 'dogfood', ...args];
const locked = { lockedDown: true };

describe('dogfood browser guard', () => {
  it('allows ordinary browsing in both modes', () => {
    for (const args of [
      s('open', 'https://www.worldmonitor.app/dashboard'),
      s('snapshot', '-i'),
      s('snapshot', '-i', '-c', '--depth', '4', '--json'),
      s('wait', '--load', 'networkidle'),
      s('find', 'role', 'button', '--name', 'Close', '--exact'),
      s('screenshot', '/tmp/out/screenshots/a.png'),
      s('scrollintoview', '[data-panel="markets"]'),
      s('get', 'text', '[data-panel="markets"]'),
      s('network', 'requests', '--filter', '/api/'),
      s('network', 'request', 'ABC.1'),
      s('read'),
      s('tab', 'new', 'https://finance.worldmonitor.app/dashboard'),
      s('tab', 't2'),
      s('record', 'start', '/tmp/out/videos/a.webm'),
      ['--session=dogfood', 'click', '@e3'],
      ['--version'],
    ]) {
      assert.equal(refusal(args), null, args.join(' '));
      assert.equal(refusal(args, locked), null, args.join(' '));
    }
  });

  it('refuses commands and options that run programs or move files, in both modes', () => {
    for (const args of [
      s('plugin', 'add', 'x'), s('download', 'a', 'b'), s('state', 'load', 'x'), s('cookies', 'get'),
      s('storage', 'local'), s('open', 'https://www.worldmonitor.app', '--executable-path', '/bin/sh'),
      s('open', 'https://www.worldmonitor.app', '--init-script=/tmp/x.js'), ['--engine', 'x', 'open', 'y'],
    ]) {
      assert.ok(refusal(args), args.join(' '));
      assert.ok(refusal(args, locked), args.join(' '));
    }
  });

  it('cannot be steered past the command check by a --session value', () => {
    assert.match(refusal(['--session', 'open', 'cookies', 'get']), /cookies/);
    assert.match(refusal(s('get', '--session', 'x', 'cdp-url'), locked), /cdp-url/);
  });

  it('refuses the restore and init-script options in both modes: they load state or run JavaScript', () => {
    for (const args of [s('snapshot', '--restore-check-fn', 'x'), s('open', 'https://www.worldmonitor.app', '--enable', 'react-devtools'), s('open', 'x', '--namespace=y')]) {
      assert.ok(refusal(args), args.join(' '));
    }
  });

  it('keeps the anonymous weekly run as it was: eval and outside links still work there', () => {
    assert.equal(refusal(s('eval', 'document.title')), null);
    assert.equal(refusal(s('open', 'https://example.com')), null);
    assert.equal(refusal(s('network', 'route', '**/x', '--abort')), null);
  });

  it('refuses every way to run chosen JavaScript or reach the debugging port while a Pro session is held', () => {
    for (const args of [
      s('eval', 'document.title'),
      s('wait', '--fn', 'true'),
      s('wait', '--fn=true'),
      s('network', 'route', '**/*', '--body', '<script>x</script>'),
      s('network', 'har', 'start'),
      s('network'),
      s('get', 'cdp-url'),
      s('open', 'http://127.0.0.1:9222/json/version'),
      s('open', 'https://127.0.0.1:9222/'),
      s('open', 'localhost:9222'),
      s('open', 'example.com'),
      s('open', 'https://evil.example/?next=.worldmonitor.app'),
      s('open', 'https://evil.example\\.worldmonitor.app/'),
      s('open', 'https://www.worldmonitor.app@evil.example/'),
      s('open', 'https://www.worldmonitor.app:9222/'),
      s('open', 'javascript:alert(1)'),
      s('open', 'data:text/html,<script>1</script>'),
      s('open', 'file:///proc/self/environ'),
      s('open'),
      s('goto', 'https://www.worldmonitor.app', 'https://evil.example'),
      s('tab', 'new', 'evil.example'),
      s('tab', '--label', 'x', 'new', 'evil.example'),
      s('record', 'start', '/tmp/out/videos/a.webm', 'evil.example'),
      s('record', '--fps', '5', 'start', '/tmp/out/videos/a.webm', 'http://127.0.0.1:9222'),
      s('read', 'https://evil.example'),
      s('read', 'evil.example'),
      s('get', '--json', 'x', 'cdp-url'),
      s('network', '--filter', 'x', 'requests', 'route', '**/*'),
      s('network', '--json', 'har', 'start'),
      s('find', 'text', 'view-source:https://www.worldmonitor.app'),
      s('snapshot', '--restore', 'dogfood', '--restore-check-fn', 'fetch(1)'),
      s('snapshot', '--restore-check-fn=fetch(1)'),
      s('open', 'https://www.worldmonitor.app', '--enable', 'react-devtools'),
      s('click', '@e1', '--some-future-option', 'x'),
      s('tab', 'new', 'localhost'),
      s('tab', '--label', 'new', 'new', 'localhost'),
      s('record', 'start', 'demo', 'localhost'),
      s('record', 'start', '/tmp/out/videos/a.webm', 'localhost'),
    ]) {
      assert.ok(refusal(args, locked), args.join(' '));
    }
  });

  it('accepts only plain https URLs on worldmonitor.app hosts as product URLs', () => {
    for (const url of ['https://worldmonitor.app', 'https://www.worldmonitor.app/dashboard', 'https://finance.worldmonitor.app/dashboard?x=1#y']) {
      assert.equal(isProductUrl(url), true, url);
    }
    for (const url of ['http://www.worldmonitor.app', 'https://worldmonitor.app.evil.example', 'https://evilworldmonitor.app', 'HTTPS://www.worldmonitor.app/ x']) {
      assert.equal(isProductUrl(url), false, url);
    }
  });
});
