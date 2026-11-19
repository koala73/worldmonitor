import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { copyText } from '@/utils/copy-text';
import { createBrowserEnvironment, type MiniElement } from './helpers/mini-dom.mts';

const SHARE_URL = 'https://www.worldmonitor.app/dashboard?c=UA';

interface Harness {
  writeText: ((text: string) => Promise<void>) | undefined;
  execCommand: ((command: string) => boolean) | undefined;
  commands: string[];
  textareaValue: string | null;
}

function install(clipboard: 'present' | 'missing', exec: 'success' | 'throw' | 'missing'): Harness {
  const env = createBrowserEnvironment();
  const harness: Harness = {
    writeText: undefined,
    execCommand: undefined,
    commands: [],
    textareaValue: null,
  };
  if (clipboard === 'present') {
    harness.writeText = async () => {};
  }
  if (exec === 'success') {
    harness.execCommand = (command) => {
      harness.commands.push(command);
      harness.textareaValue = env.document.querySelector('textarea')?.value ?? null;
      return true;
    };
  } else if (exec === 'throw') {
    harness.execCommand = () => {
      throw new Error('execCommand unavailable');
    };
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: clipboard === 'present' ? { writeText: harness.writeText } : undefined },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: Object.assign(env.document, { execCommand: harness.execCommand }),
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: env.window,
  });
  return harness;
}

function fallbackInput(): MiniElement | null {
  return document.querySelector('.wm-copy-fallback-input');
}

afterEach(() => {
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
});

describe('copyText', () => {
  it('copies with navigator.clipboard.writeText when that API is present', async () => {
    const harness = install('present', 'missing');
    const seen: string[] = [];
    harness.writeText = async (text) => {
      seen.push(text);
    };
    (navigator as Navigator).clipboard.writeText = harness.writeText;

    const copied = await copyText(SHARE_URL);

    assert.equal(copied, true);
    assert.deepEqual(seen, [SHARE_URL]);
    assert.equal(harness.commands.length, 0);
    assert.equal(fallbackInput(), null);
  });

  it('copies with execCommand when navigator.clipboard is undefined', async () => {
    const harness = install('missing', 'success');

    const copied = await copyText(SHARE_URL);

    assert.equal(copied, true);
    assert.deepEqual(harness.commands, ['copy']);
    assert.equal(harness.textareaValue, SHARE_URL);
    assert.equal(document.querySelector('textarea'), null);
    assert.equal(fallbackInput(), null);
  });

  it('shows the text for manual copy when the clipboard and execCommand are unavailable', async () => {
    install('missing', 'missing');

    const copied = await copyText(SHARE_URL);

    assert.equal(copied, false);
    assert.equal(fallbackInput()?.value, SHARE_URL);
    assert.equal(document.querySelector('textarea'), null);

    install('missing', 'throw');
    const thrown = await copyText(SHARE_URL).then(
      (result) => result,
      (error: unknown) => error,
    );
    assert.equal(thrown, false);
    assert.equal(fallbackInput()?.value, SHARE_URL);
  });
});
