import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';
import { Window } from 'happy-dom';

import { watchAuthModalDismissal } from '../pro-test/src/services/auth-modal-watch.ts';

let browser: Window;
const GLOBALS = ['window', 'document', 'MutationObserver'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
let stops: Array<() => void> = [];

beforeEach(() => {
  browser = new Window({ url: 'https://www.worldmonitor.app/pro#pricing' });
  const values = { window: browser, document: browser.document, MutationObserver: browser.MutationObserver };
  for (const key of GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  }
});

afterEach(async () => {
  for (const stop of stops) stop();
  stops = [];
  mock.timers.reset();
  await browser.happyDOM.abort();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

function openModal(withCodeStep = false): HTMLElement {
  const modal = browser.document.createElement('div');
  modal.className = 'cl-modalBackdrop';
  if (withCodeStep) {
    const code = browser.document.createElement('div');
    code.className = 'cl-otpCodeField';
    modal.appendChild(code);
  }
  browser.document.body.appendChild(modal);
  return modal as unknown as HTMLElement;
}

function watch(isSignedIn: () => boolean, maxMs?: number) {
  const calls: Array<{ reachedCodeStep: boolean }> = [];
  stops.push(watchAuthModalDismissal({ isSignedIn, onDismissed: (info) => calls.push(info), maxMs }));
  return calls;
}

it('reports a close without sign-in once', async () => {
  const calls = watch(() => false);
  const modal = openModal();
  await settle();
  modal.remove();
  await settle();
  openModal().remove();
  await settle();
  assert.deepEqual(calls, [{ reachedCodeStep: false }]);
});

it('reports nothing when the modal closes after a sign-in', async () => {
  const calls = watch(() => true);
  const modal = openModal();
  await settle();
  modal.remove();
  await settle();
  assert.deepEqual(calls, []);
});

it('stops without a report when the modal never appears', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const calls = watch(() => false);
  mock.timers.tick(5_000);
  const modal = openModal();
  await settle();
  modal.remove();
  await settle();
  assert.deepEqual(calls, []);
});

it('records that the email-code step was reached', async () => {
  const calls = watch(() => false);
  const modal = openModal();
  await settle();
  const code = browser.document.createElement('input');
  code.setAttribute('autocomplete', 'one-time-code');
  modal.appendChild(code as unknown as Node);
  await settle();
  modal.remove();
  await settle();
  assert.deepEqual(calls, [{ reachedCodeStep: true }]);
});

it('disconnects after maxMs', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const calls = watch(() => false, 1_000);
  const modal = openModal(true);
  await settle();
  mock.timers.tick(1_000);
  modal.remove();
  await settle();
  assert.deepEqual(calls, []);
});

it('stops the previous watcher when a new one starts', async () => {
  const first = watch(() => false);
  const modal = openModal();
  await settle();
  const second = watch(() => false);
  await settle();
  modal.remove();
  await settle();
  assert.deepEqual(first, []);
  assert.deepEqual(second, [{ reachedCodeStep: false }]);
});
