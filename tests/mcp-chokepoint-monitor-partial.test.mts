// PortWatch history is not the same signal as today's AIS counts. When
// dataAvailable is false the chokepoint monitor used to drop the whole
// row, so a partial board looked complete and an all-gap board looked empty.

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { Window } from 'happy-dom';

import { CHOKEPOINT_MONITOR_APP_HTML } from '../api/mcp/ui/chokepoint-monitor-app';

const PAYLOAD = {
  cached_at: '2026-08-25T12:00:00Z',
  stale: false,
  data: {
    'transit-summaries': {
      summaries: {
        hormuz: {
          todayTotal: 42,
          todayTanker: 11,
          wowChangePct: -80,
          riskLevel: 'high',
          riskSummary: 'Corridor risk remains elevated',
          dataAvailable: false,
        },
        suez: {
          todayTotal: 18,
          todayTanker: 4,
          wowChangePct: 12.5,
          riskLevel: 'normal',
          dataAvailable: true,
        },
      },
    },
  },
};

let win: Window;
let doc: Window['document'];

function textOf(selector: string): string[] {
  return [...doc.querySelectorAll(selector)].map((node) => String(node.textContent));
}

describe('chokepoint monitor keeps AIS rows when PortWatch history is missing', () => {
  before(async () => {
    win = new Window({ url: 'https://worldmonitor.app/' });
    win.document.write(CHOKEPOINT_MONITOR_APP_HTML);
    await win.happyDOM.waitUntilComplete();
    const script = win.document.querySelector('script');
    assert.ok(script && script.textContent && script.textContent.length > 0);
    win.eval(script.textContent);
    const hostWindow = win.eval('window.parent');
    win.dispatchEvent(new win.MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: { result: { content: [{ type: 'text', text: JSON.stringify(PAYLOAD) }] } },
      },
      source: hostWindow,
    }));
    await win.happyDOM.waitUntilComplete();
    doc = win.document;
  });

  after(async () => {
    await win?.happyDOM?.close();
  });

  it('renders the PortWatch-gap strait from AIS counts and corridor risk', () => {
    const names = textOf('.cname');
    assert.ok(names.includes('Hormuz'), `expected Hormuz to stay visible, got ${names.join(', ') || '(none)'}`);
    const hormuz = [...doc.querySelectorAll('.crow')].find((row) => row.querySelector('.cname')?.textContent === 'Hormuz');
    assert.ok(hormuz);
    assert.match(hormuz.textContent ?? '', /42/);
    assert.match(hormuz.textContent ?? '', /high/i);
    assert.match(hormuz.textContent ?? '', /PortWatch history unavailable/i);
    assert.doesNotMatch(hormuz.textContent ?? '', /-80/);
    assert.equal((hormuz.textContent ?? '').includes('Week over week'), true);
  });

  it('still renders week-over-week when PortWatch history is present', () => {
    const suez = [...doc.querySelectorAll('.crow')].find((row) => row.querySelector('.cname')?.textContent === 'Suez');
    assert.ok(suez);
    assert.match(suez.textContent ?? '', /\+12\.50%/);
    assert.doesNotMatch(suez.textContent ?? '', /PortWatch history unavailable/i);
  });
});
