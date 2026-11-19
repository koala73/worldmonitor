import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { copyText, dismissSecretCopyFallback } from '@/utils/copy-text';
import { createBrowserEnvironment } from './helpers/mini-dom.mts';

const SHARE_URL = 'https://www.worldmonitor.app/dashboard?c=UA';

interface Harness {
  writeText: (text: string) => Promise<void>;
  commands: string[];
  textareaValue: string | null;
}

const originals = {
  navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
};

function restore(key: 'navigator' | 'document' | 'window'): void {
  const descriptor = originals[key];
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else delete (globalThis as Record<string, unknown>)[key];
}

function install(clipboard: 'present' | 'missing', exec: 'success' | 'throw' | 'missing'): Harness {
  const env = createBrowserEnvironment();
  const harness: Harness = {
    writeText: async () => {},
    commands: [],
    textareaValue: null,
  };
  let execCommand: ((command: string) => boolean) | undefined;
  if (exec === 'success') {
    execCommand = (command) => {
      harness.commands.push(command);
      harness.textareaValue = (env.document.querySelector('textarea') as { value?: string } | null)?.value ?? null;
      return true;
    };
  } else if (exec === 'throw') {
    execCommand = () => {
      throw new Error('execCommand unavailable');
    };
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: clipboard === 'present'
        ? { writeText: (text: string) => harness.writeText(text) }
        : undefined,
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: Object.assign(env.document, { execCommand }),
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: env.window,
  });
  return harness;
}

function fallbackValue(): string | undefined {
  const input = document.querySelector('.wm-copy-fallback-input') as { value?: string } | null;
  return input?.value;
}

afterEach(() => {
  restore('navigator');
  restore('document');
  restore('window');
});

describe('copyText', () => {
  it('copies with navigator.clipboard.writeText when that API is present', async () => {
    const harness = install('present', 'missing');
    const seen: string[] = [];
    harness.writeText = async (text) => {
      seen.push(text);
    };

    const copied = await copyText(SHARE_URL);

    assert.equal(copied, true);
    assert.deepEqual(seen, [SHARE_URL]);
    assert.equal(harness.commands.length, 0);
    assert.equal(fallbackValue(), undefined);
  });

  it('copies with execCommand when navigator.clipboard is undefined', async () => {
    const harness = install('missing', 'success');

    const copied = await copyText(SHARE_URL);

    assert.equal(copied, true);
    assert.deepEqual(harness.commands, ['copy']);
    assert.equal(harness.textareaValue, SHARE_URL);
    assert.equal(document.querySelector('textarea'), null);
    assert.equal(fallbackValue(), undefined);
  });

  it('shows the text for manual copy when the clipboard and execCommand are unavailable', async () => {
    install('missing', 'missing');

    const copied = await copyText(SHARE_URL);

    assert.equal(copied, false);
    assert.equal(fallbackValue(), SHARE_URL);
    assert.equal((document.querySelector('.wm-copy-fallback-input') as { tagName?: string } | null)?.tagName, 'TEXTAREA');

    install('missing', 'throw');
    const thrown = await copyText(SHARE_URL).then(
      (result) => result,
      (error: unknown) => error,
    );
    assert.equal(thrown, false);
    assert.equal(fallbackValue(), SHARE_URL);
  });

  it('uses execCommand when writeText throws synchronously', async () => {
    const harness = install('present', 'success');
    harness.writeText = () => {
      throw new Error('sync');
    };

    const copied = await copyText(SHARE_URL);

    assert.equal(copied, true);
    assert.deepEqual(harness.commands, ['copy']);
    assert.equal(fallbackValue(), undefined);
  });

  it('uses execCommand when writeText rejects', async () => {
    const harness = install('present', 'success');
    harness.writeText = async () => {
      throw new Error('denied');
    };

    const copied = await copyText(SHARE_URL);

    assert.equal(copied, true);
    assert.deepEqual(harness.commands, ['copy']);
    assert.equal(fallbackValue(), undefined);
  });

  it('skips the manual field when retain returns false', async () => {
    install('missing', 'missing');

    const copied = await copyText(SHARE_URL, { retain: () => false });

    assert.equal(copied, false);
    assert.equal(fallbackValue(), undefined);
  });

  it('keeps line breaks in the manual copy field', async () => {
    install('missing', 'missing');
    const text = 'Use the tool.\nCountries: Ukraine (UA).';

    const copied = await copyText(text);

    assert.equal(copied, false);
    assert.equal(fallbackValue(), text);
  });

  it('returns focus to the control that started an execCommand copy', async () => {
    install('missing', 'success');
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    const copied = await copyText(SHARE_URL);

    assert.equal(copied, true);
    assert.equal(document.activeElement, button);
  });

  it('returns focus when the manual copy field is closed', async () => {
    install('missing', 'missing');
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    await copyText(SHARE_URL);
    assert.equal(document.activeElement, document.querySelector('.wm-copy-fallback-input'));

    (document.querySelector('.wm-copy-fallback-close') as HTMLButtonElement | null)?.click();

    assert.equal(document.querySelector('.wm-copy-fallback'), null);
    assert.equal(document.activeElement, button);
  });

  it('removes a revealed secret and leaves an ordinary fallback in place', async () => {
    install('missing', 'missing');
    await copyText(SHARE_URL);

    dismissSecretCopyFallback();

    assert.equal(fallbackValue(), SHARE_URL);
    await copyText('wm_live_secret', { secret: true });
    assert.equal(fallbackValue(), 'wm_live_secret');
    assert.ok(document.querySelector('.wm-copy-fallback[data-copy-secret]'));

    dismissSecretCopyFallback();

    assert.equal(document.querySelector('.wm-copy-fallback'), null);
  });
});
