// ChatGPT app-submission metadata on ui:// views and the tools that render them.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { TOOL_LIST_RESPONSE } from '../api/mcp/registry/index.ts';
import { UI_RESOURCE_LIST_RESPONSE } from '../api/mcp/ui/registry.ts';

describe('MCP view metadata', () => {
  it('every ui:// view declares the same exact HTTPS origin as _meta.ui.domain', () => {
    const views = UI_RESOURCE_LIST_RESPONSE.filter((r) => r.uri.startsWith('ui://'));
    assert.ok(views.length >= 12);
    const domains = new Set(views.map((r) => r._meta?.ui?.domain));
    assert.equal(domains.size, 1, [...domains].join(', '));
    const [domain] = domains;
    assert.equal(new URL(domain).origin, domain, 'must be an origin with no path');
    assert.equal(new URL(domain).protocol, 'https:');
  });

  it('every tool that renders a view carries present-tense openai/toolInvocation labels', () => {
    const uiTools = TOOL_LIST_RESPONSE.filter((t) => t._meta?.ui?.resourceUri);
    assert.ok(uiTools.length >= 12);
    for (const t of uiTools) {
      const inv = t._meta['openai/toolInvocation'];
      assert.ok(inv, `${t.name} missing openai/toolInvocation`);
      assert.equal(typeof inv.invoking, 'string');
      assert.equal(typeof inv.invoked, 'string');
      assert.ok(inv.invoking.length > 0 && inv.invoked.length > 0, t.name);
      // The wire keys ChatGPT actually reads, <= 64 chars each.
      assert.equal(t._meta['openai/toolInvocation/invoking'], inv.invoking, t.name);
      assert.equal(t._meta['openai/toolInvocation/invoked'], inv.invoked, t.name);
      assert.ok(inv.invoking.length <= 64 && inv.invoked.length <= 64, t.name);
    }
    const others = TOOL_LIST_RESPONSE.filter((t) => !t._meta?.ui?.resourceUri && (t._meta['openai/toolInvocation'] || t._meta['openai/toolInvocation/invoking']));
    assert.deepEqual(others.map((t) => t.name), [], 'labels only on view-rendering tools');
  });
});
