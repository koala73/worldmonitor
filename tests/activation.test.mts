import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { bindActivationKeys } from '../src/utils/activation.ts';
import { createBrowserEnvironment, type MiniElement } from './helpers/mini-dom.mts';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');

function installDom() {
  const browser = createBrowserEnvironment();
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: browser.document,
  });
  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    writable: true,
    value: browser.HTMLElement,
  });
  return browser.document;
}

function restoreDom(): void {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: unknown }).document;
  if (originalHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', originalHTMLElement);
  else delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
}

function dispatchKey(
  root: MiniElement,
  target: MiniElement,
  key: string,
  options: { repeat?: boolean } = {},
): Event {
  const event = new Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    target: { configurable: true, get: () => target },
    key: { value: key },
    repeat: { value: options.repeat ?? false },
  });
  root.dispatchEvent(event);
  return event;
}

afterEach(restoreDom);

describe('bindActivationKeys', () => {
  it('turns Enter/Space on a matching row into a click, ignoring other keys and non-rows', () => {
    const document = installDom();
    const content = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'drill-row';
    content.appendChild(row);
    const outside = document.createElement('div');
    content.appendChild(outside);

    let clicks = 0;
    content.addEventListener('click', () => { clicks += 1; });

    bindActivationKeys(content as unknown as HTMLElement, '.drill-row');

    const enter = dispatchKey(content, row, 'Enter');
    const space = dispatchKey(content, row, ' ');
    dispatchKey(content, row, 'Tab');
    dispatchKey(content, outside, 'Enter');

    assert.equal(clicks, 2);
    assert.equal(enter.defaultPrevented, true);
    assert.equal(space.defaultPrevented, true);
  });

  it('leaves keydown alone when focus is on a nested control inside the row', () => {
    const document = installDom();
    const content = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'drill-row';
    const nested = document.createElement('button');
    row.appendChild(nested);
    content.appendChild(row);

    let clicks = 0;
    content.addEventListener('click', () => { clicks += 1; });

    bindActivationKeys(content as unknown as HTMLElement, '.drill-row');

    const event = dispatchKey(content, nested, 'Enter');

    assert.equal(clicks, 0);
    assert.equal(event.defaultPrevented, false);
  });

  it('does not stack listeners when bound twice on the same root and selector', () => {
    const document = installDom();
    const content = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'drill-row';
    content.appendChild(row);

    let clicks = 0;
    content.addEventListener('click', () => { clicks += 1; });

    bindActivationKeys(content as unknown as HTMLElement, '.drill-row');
    bindActivationKeys(content as unknown as HTMLElement, '.drill-row');

    dispatchKey(content, row, 'Enter');
    assert.equal(clicks, 1);
  });

  it('ignores repeating Enter/Space so a held key does not keep clicking', () => {
    const document = installDom();
    const content = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'drill-row';
    content.appendChild(row);

    let clicks = 0;
    content.addEventListener('click', () => { clicks += 1; });

    bindActivationKeys(content as unknown as HTMLElement, '.drill-row');

    const held = dispatchKey(content, row, ' ', { repeat: true });
    assert.equal(clicks, 0);
    assert.equal(held.defaultPrevented, false);

    const first = dispatchKey(content, row, ' ');
    assert.equal(clicks, 1);
    assert.equal(first.defaultPrevented, true);
  });

  it('still activates a replacement row after the bound root is re-filled', () => {
    const document = installDom();
    const content = document.createElement('div');
    const firstRow = document.createElement('div');
    firstRow.className = 'drill-row';
    content.appendChild(firstRow);

    let clicks = 0;
    content.addEventListener('click', () => { clicks += 1; });

    bindActivationKeys(content as unknown as HTMLElement, '.drill-row');

    content.innerHTML = '';
    const replacement = document.createElement('div');
    replacement.className = 'drill-row';
    content.appendChild(replacement);

    dispatchKey(content, replacement, 'Enter');
    assert.equal(clicks, 1);
  });
});
