import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { SEQ } from '../src/tui/term/ansi.mjs';
import { launchTui } from '../src/tui/index.mjs';

// A fake TTY pair: stdin records raw-mode changes, stdout records every write.
function fakeTerminal() {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.raw = [];
  stdin.setRawMode = (on) => stdin.raw.push(on);
  stdin.resume = () => {};
  stdin.pause = () => {};
  const stdout = new EventEmitter();
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.out = '';
  stdout.write = (s) => {
    stdout.out += s;
    return true;
  };
  return { stdin, stdout };
}

describe('launchTui', () => {
  it('restores the terminal and cancels boot requests when quitting mid-boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-tui-launch-'));
    const requests = [];
    let aborted = 0;
    // Every request hangs until aborted, so quitting happens with boot in flight.
    const fetchImpl = (url, init) =>
      new Promise((_, reject) => {
        requests.push(url);
        init.signal.addEventListener('abort', () => {
          aborted += 1;
          reject(init.signal.reason);
        });
      });
    const { stdin, stdout } = fakeTerminal();
    const sigint = process.listenerCount('SIGINT');
    const crash = process.listenerCount('uncaughtException');
    try {
      const done = launchTui({ options: { noAnim: true }, config: {}, env: { XDG_CONFIG_HOME: dir }, stdin, stdout, fetchImpl });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(requests.length, 1, 'boot is waiting on its first request');
      assert.ok(stdout.out.includes(SEQ.altScreenOn));
      stdin.emit('data', Buffer.from('q'));
      assert.equal(await done, 0);
      assert.equal(aborted, 1, 'the in-flight boot request is aborted');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(requests.length, 1, 'boot does not continue after quitting');
      const tail = stdout.out.slice(stdout.out.lastIndexOf(SEQ.mouseOff));
      for (const seq of [SEQ.mouseOff, SEQ.cursorShow, SEQ.altScreenOff]) assert.ok(tail.includes(seq));
      assert.deepEqual(stdin.raw, [true, false]);
      assert.equal(stdin.listenerCount('data'), 0);
      assert.equal(process.listenerCount('SIGINT'), sigint);
      assert.equal(process.listenerCount('uncaughtException'), crash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
