import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, it } from 'node:test';

import {
  bindMarketChartActivation,
  createMarketChartFocusController,
  getMarketChartRowAttributes,
  hasPlottableMarketSeries,
  type MarketChartFocusController,
} from '../src/components/market-chart-interactions.ts';
import type { MarketData } from '../src/types/index.ts';
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

function stock(symbol: string, sparkline: number[] | undefined): MarketData {
  return {
    symbol,
    display: symbol,
    name: symbol,
    price: 100,
    change: 1,
    sparkline,
  };
}

function keyEvent(key: string, shiftKey = false): KeyboardEvent {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    shiftKey: { value: shiftKey },
  });
  return event as KeyboardEvent;
}

afterEach(restoreDom);

describe('market chart row interactions', () => {
  it('only renders chart semantics for plottable market rows', () => {
    const plottable = stock('AAPL', [100, Number.NaN, 101]);
    const unavailable = stock('EMPTY', [100]);

    assert.equal(hasPlottableMarketSeries(plottable), true);
    assert.equal(hasPlottableMarketSeries(unavailable), false);
    assert.match(getMarketChartRowAttributes(plottable, 2, 'AAPL "price" chart'), /data-market-chart="2"/);
    assert.match(getMarketChartRowAttributes(plottable, 2, 'AAPL "price" chart'), /role="button" tabindex="0"/);
    assert.match(getMarketChartRowAttributes(plottable, 2, 'AAPL "price" chart'), /aria-label="AAPL &quot;price&quot; chart"/);
    assert.equal(getMarketChartRowAttributes(unavailable, 3, 'Unavailable chart'), ' class="market-item"');
  });

  it('opens a plottable row with click, Enter, and Space but ignores inert rows', () => {
    const document = installDom();
    const content = document.createElement('div');
    const handlers = new Map<string, EventListener>();
    content.addEventListener = ((type: string, listener: EventListener) => {
      handlers.set(type, listener);
    }) as typeof content.addEventListener;

    const active = stock('AAPL', [100, 101]);
    const inactive = stock('EMPTY', [100]);
    const opened: MarketData[] = [];
    bindMarketChartActivation(
      content as unknown as HTMLElement,
      () => [active, inactive],
      (selected) => opened.push(selected),
    );

    const row = document.createElement('div');
    row.setAttribute('data-market-chart', '0');
    const rowChild = document.createElement('span');
    row.appendChild(rowChild);
    const inertRow = document.createElement('div');
    const inertChild = document.createElement('span');
    inertRow.appendChild(inertChild);

    const dispatch = (type: 'click' | 'keydown', target: MiniElement, key = ''): Event => {
      const event = new Event(type, { cancelable: true });
      Object.defineProperties(event, {
        target: { value: target },
        key: { value: key },
      });
      handlers.get(type)?.(event);
      return event;
    };

    dispatch('click', rowChild);
    dispatch('keydown', rowChild, 'Enter');
    const space = dispatch('keydown', rowChild, ' ');
    dispatch('click', inertChild);
    dispatch('keydown', inertChild, 'Enter');

    assert.deepEqual(opened, [active, active, active]);
    assert.equal(space.defaultPrevented, true);
  });
});

describe('market chart modal focus lifecycle', () => {
  it('traps Tab, closes on Escape, and restores the opening row', () => {
    const document = installDom();
    const opener = document.createElement('button');
    const dialog = document.createElement('div');
    const first = document.createElement('button');
    const last = document.createElement('button');
    dialog.append(first, last);
    document.body.append(opener, dialog);
    opener.focus();

    let escapeCount = 0;
    let controller: MarketChartFocusController;
    controller = createMarketChartFocusController(
      dialog as unknown as HTMLElement,
      () => {
        escapeCount += 1;
        dialog.remove();
        controller.deactivate();
      },
      opener as unknown as HTMLElement,
    );
    controller.activate(first as unknown as HTMLElement);
    assert.equal(document.activeElement, first);

    first.focus();
    const backwards = keyEvent('Tab', true);
    document.dispatchEvent(backwards);
    assert.equal(backwards.defaultPrevented, true);
    assert.equal(document.activeElement, last);

    const forwards = keyEvent('Tab');
    document.dispatchEvent(forwards);
    assert.equal(forwards.defaultPrevented, true);
    assert.equal(document.activeElement, first);

    opener.focus();
    document.dispatchEvent(keyEvent('Tab'));
    assert.equal(document.activeElement, first);

    document.dispatchEvent(keyEvent('Escape'));
    assert.equal(escapeCount, 1);
    assert.equal(document.activeElement, opener);
  });
});

describe('market chart shell translations', () => {
  it('keeps first-paint English chart labels aligned with the full locale', async () => {
    const [shell, full] = await Promise.all([
      readFile(new URL('../src/locales/en.shell.json', import.meta.url), 'utf8').then(JSON.parse),
      readFile(new URL('../src/locales/en.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);

    assert.deepEqual(shell.components.markets.chart, full.components.markets.chart);
  });
});
