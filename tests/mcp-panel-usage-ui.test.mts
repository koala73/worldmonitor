import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { UI_RESOURCE_REGISTRY } from '../api/mcp/ui/registry';

const usage = { used: 1, limit: 50, remaining: 49, resetsAt: '2026-10-03T00:00:00.000Z', unit: 'requests' };
describe('remaining usage in every static embedded panel', () => {
  assert.equal(UI_RESOURCE_REGISTRY.length, 10);
  const staticResources = UI_RESOURCE_REGISTRY.filter(resource => resource.html);
  assert.equal(staticResources.length, 9);
  for (const resource of staticResources) {
    it(`${resource.name} consumes host usage metadata without making data calls`, async () => {
      const win: any = new Window({ url: 'https://worldmonitor.app/' });
      try {
        win.document.write(resource.html);
        await win.happyDOM.waitUntilComplete();
        const host = win.eval('window.parent');
        const calls: string[] = [];
        host.postMessage = (message: { method?: string }) => { if (message.method) calls.push(message.method); };
        win.eval(win.document.querySelector('script').textContent);
        const send = (result: object) => win.dispatchEvent(new win.MessageEvent('message', {
          source: host, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { result } },
        }));
        send({ structuredContent: {}, _meta: { 'worldmonitor/usage': usage } });
        const notice = win.document.getElementById('panel-usage');
        assert.match(notice.textContent, /49 of 50 requests remaining/);
        assert.match(notice.textContent, /Opening this panel uses 1 request/);
        assert.equal(notice.hidden, false);
        send({ structuredContent: {}, _meta: { 'worldmonitor/usage': { ...usage, remaining: 48 } } });
        assert.match(notice.textContent, /48 of 50 requests remaining/);
        send({ structuredContent: {} });
        assert.equal(notice.hidden, true);
        assert.ok(!calls.includes('tools/call'));
      } finally { await win.happyDOM.close(); }
    });
  }
});
