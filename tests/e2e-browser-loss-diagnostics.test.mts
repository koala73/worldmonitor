import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachBrowserLossDiagnostics,
  type BrowserLossEvents,
} from '../e2e/browser-loss-diagnostics';

function fakeEvents(): BrowserLossEvents & {
  crash(): void;
  disconnect(): void;
  closeContext(): void;
} {
  const listeners = { crash: new Set<() => void>(), disc: new Set<() => void>(), close: new Set<() => void>() };
  const subscribe = (set: Set<() => void>, listener: () => void) => {
    set.add(listener);
    return () => { set.delete(listener); };
  };
  return {
    onCrash: (l) => subscribe(listeners.crash, l),
    onBrowserDisconnected: (l) => subscribe(listeners.disc, l),
    onContextClose: (l) => subscribe(listeners.close, l),
    crash: () => listeners.crash.forEach((l) => l()),
    disconnect: () => listeners.disc.forEach((l) => l()),
    closeContext: () => listeners.close.forEach((l) => l()),
  };
}

const NOW = () => '2026-09-05T00:00:00.000Z';

describe('attachBrowserLossDiagnostics (#6501)', () => {
  it('names a renderer crash', () => {
    const events = fakeEvents();
    const lines: string[] = [];
    attachBrowserLossDiagnostics(events, 'spec boot', (l) => lines.push(l), NOW);

    events.crash();
    events.crash();

    assert.deepEqual(lines, ['[browser-loss] kind=renderer-crash spec="spec boot" at=2026-09-05T00:00:00.000Z']);
  });

  it('names a browser-process exit', () => {
    const events = fakeEvents();
    const lines: string[] = [];
    attachBrowserLossDiagnostics(events, 'spec boot', (l) => lines.push(l), NOW);

    events.disconnect();

    assert.match(lines[0]!, /kind=browser-disconnected/);
  });

  it('retains browser-disconnected when it follows context-close on a later turn', async () => {
    const events = fakeEvents();
    const lines: string[] = [];
    attachBrowserLossDiagnostics(events, 'spec boot', (l) => lines.push(l), NOW);

    events.closeContext();
    await new Promise((resolve) => setImmediate(resolve));
    events.disconnect();

    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /kind=context-closed/);
    assert.match(lines[1]!, /kind=browser-disconnected/);
  });

  it('records a standalone context close inside the boot window', async () => {
    const armed = fakeEvents();
    const armedLines: string[] = [];
    attachBrowserLossDiagnostics(armed, 'spec boot', (l) => armedLines.push(l), NOW);
    armed.closeContext();
    assert.match(armedLines[0]!, /kind=context-closed/);
  });

  it('all signals after dispose are silent teardown', async () => {
    const disposed = fakeEvents();
    const disposedLines: string[] = [];
    const watch = attachBrowserLossDiagnostics(disposed, 'spec boot', (l) => disposedLines.push(l), NOW);
    watch.dispose();
    disposed.crash();
    disposed.disconnect();
    disposed.closeContext();
    await Promise.resolve();
    assert.deepEqual(disposedLines, [], 'every green test closes its context; that must not print');
  });
});
