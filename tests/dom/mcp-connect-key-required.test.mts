/**
 * A Quick Connect preset that needs an API key must not be addable without one.
 *
 * Picking a keyed preset card pre-fills its default tool, which used to enable
 * "Add Panel" at once. A Pro user added the Tavily preset with the key field
 * still empty; the saved panel then sent no Authorization header, Tavily
 * rejected every refresh with HTTP 401, and the proxy reported each one to
 * Sentry (WORLDMONITOR-172: 108 calls from one browser in three hours, every
 * one with `header_names: []` in the proxy audit log).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/premium-fetch', () => ({ premiumFetch: vi.fn() }));
vi.mock('@/services/analytics', () => ({ track: vi.fn() }));

import { closeMcpConnectModal, openMcpConnectModal } from '@/components/McpConnectModal';
import { MCP_PRESETS, type McpPanelSpec } from '@/services/mcp-store';

const TAVILY = MCP_PRESETS.find((p) => p.name === 'Tavily Search');
const KEYLESS = MCP_PRESETS.find((p) => !p.apiKeyHeader && !p.authNote && p.defaultTool);

function q<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

function pickPreset(serverUrl: string): void {
  const card = [...document.querySelectorAll<HTMLElement>('.mcp-preset-card')]
    .find((c) => c.dataset.url === serverUrl);
  if (!card) throw new Error(`no preset card for ${serverUrl}`);
  card.click();
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  closeMcpConnectModal();
  document.body.replaceChildren();
});

describe('MCP connect modal — keyed presets', () => {
  it('keeps Add Panel disabled until the preset API key is entered', () => {
    expect(TAVILY?.apiKeyHeader).toBeTruthy();
    const onComplete = vi.fn();
    openMcpConnectModal({ onComplete });

    pickPreset(TAVILY!.serverUrl);
    const addBtn = q<HTMLButtonElement>('.mcp-add-btn');
    expect(addBtn.disabled).toBe(true);

    addBtn.disabled = false; // a forced click must still be refused
    addBtn.click();
    expect(onComplete).not.toHaveBeenCalled();

    typeInto(q<HTMLInputElement>('.mcp-api-key'), 'tvly-test-key');
    expect(addBtn.disabled).toBe(false);
    addBtn.click();
    expect(onComplete).toHaveBeenCalledTimes(1);
    const spec = onComplete.mock.calls[0]![0] as McpPanelSpec;
    expect(spec.customHeaders).toEqual({ Authorization: 'Bearer tvly-test-key' });
  });

  it('disables Add Panel again when the key is cleared', () => {
    openMcpConnectModal({ onComplete: vi.fn() });
    pickPreset(TAVILY!.serverUrl);
    const key = q<HTMLInputElement>('.mcp-api-key');
    const addBtn = q<HTMLButtonElement>('.mcp-add-btn');
    typeInto(key, 'tvly-test-key');
    typeInto(key, '   ');
    expect(addBtn.disabled).toBe(true);
  });

  it('accepts the key through the advanced custom-headers field', () => {
    const onComplete = vi.fn();
    openMcpConnectModal({ onComplete });
    pickPreset(TAVILY!.serverUrl);
    q<HTMLButtonElement>('.mcp-to-advanced').click();
    typeInto(q<HTMLInputElement>('.mcp-auth-header'), 'Authorization: Bearer tvly-adv');
    const addBtn = q<HTMLButtonElement>('.mcp-add-btn');
    expect(addBtn.disabled).toBe(false);
    addBtn.click();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('still adds a keyless preset straight away', () => {
    expect(KEYLESS).toBeTruthy();
    const onComplete = vi.fn();
    openMcpConnectModal({ onComplete });
    pickPreset(KEYLESS!.serverUrl);
    const addBtn = q<HTMLButtonElement>('.mcp-add-btn');
    expect(addBtn.disabled).toBe(false);
    addBtn.click();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('refuses to save an edited keyed panel once its key is removed', () => {
    const onComplete = vi.fn();
    openMcpConnectModal({
      onComplete,
      existingSpec: {
        id: 'mcp-x', title: 'Tavily', serverUrl: TAVILY!.serverUrl,
        customHeaders: { Authorization: 'Bearer tvly-old' },
        toolName: 'tavily_search', toolArgs: {}, refreshIntervalMs: 60_000, createdAt: 1, updatedAt: 1,
      },
    });
    const addBtn = q<HTMLButtonElement>('.mcp-add-btn');
    expect(addBtn.disabled).toBe(false);
    typeInto(q<HTMLInputElement>('.mcp-api-key'), '');
    expect(addBtn.disabled).toBe(true);
  });
});
