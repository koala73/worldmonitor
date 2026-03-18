import type { McpPanelSpec, McpToolDef } from '@/services/mcp-store';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { proxyUrl } from '@/utils/proxy';

interface McpConnectOptions {
  existingSpec?: McpPanelSpec;
  onComplete: (spec: McpPanelSpec) => void;
}

let overlay: HTMLElement | null = null;

export function openMcpConnectModal(options: McpConnectOptions): void {
  closeMcpConnectModal();

  const existing = options.existingSpec;
  overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';

  const modal = document.createElement('div');
  modal.className = 'modal mcp-connect-modal';

  modal.innerHTML = `
    <div class="modal-header">
      <span class="modal-title">${escapeHtml(t('mcp.modalTitle'))}</span>
      <button class="modal-close" aria-label="${escapeHtml(t('common.close'))}">\u2715</button>
    </div>
    <div class="mcp-connect-body">
      <div class="mcp-form-group">
        <label class="mcp-label">${escapeHtml(t('mcp.serverUrl'))}</label>
        <input class="mcp-input mcp-server-url" type="url"
          placeholder="https://my-mcp-server.com/mcp"
          value="${escapeHtml(existing?.serverUrl ?? '')}" />
      </div>
      <div class="mcp-form-group">
        <label class="mcp-label">${escapeHtml(t('mcp.authHeader'))} <span class="mcp-optional">(${t('mcp.optional')})</span></label>
        <input class="mcp-input mcp-auth-header" type="text"
          placeholder="Authorization: Bearer token123"
          value="${escapeHtml(existing ? _headersToLine(existing.customHeaders) : '')}" />
      </div>
      <div class="mcp-connect-actions">
        <button class="btn btn-secondary mcp-connect-btn">${escapeHtml(t('mcp.connectBtn'))}</button>
        <span class="mcp-connect-status"></span>
      </div>
      <div class="mcp-tools-section" style="display:none">
        <label class="mcp-label">${escapeHtml(t('mcp.selectTool'))}</label>
        <div class="mcp-tools-list"></div>
      </div>
      <div class="mcp-tool-config" style="display:none">
        <div class="mcp-form-group">
          <label class="mcp-label">${escapeHtml(t('mcp.toolArgs'))}</label>
          <textarea class="mcp-input mcp-tool-args" rows="3" placeholder="{}"></textarea>
          <span class="mcp-args-error" style="display:none;color:var(--red)"></span>
        </div>
        <div class="mcp-form-group">
          <label class="mcp-label">${escapeHtml(t('mcp.panelTitle'))}</label>
          <input class="mcp-input mcp-panel-title" type="text"
            placeholder="${escapeHtml(t('mcp.panelTitlePlaceholder'))}"
            value="${escapeHtml(existing?.title ?? '')}" />
        </div>
        <div class="mcp-form-group mcp-refresh-group">
          <label class="mcp-label">${escapeHtml(t('mcp.refreshEvery'))}</label>
          <input class="mcp-input mcp-refresh-input" type="number" min="10" max="86400"
            value="${existing ? Math.round(existing.refreshIntervalMs / 1000) : 60}" />
          <span class="mcp-refresh-unit">${escapeHtml(t('mcp.seconds'))}</span>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost mcp-cancel-btn">${escapeHtml(t('common.cancel'))}</button>
      <button class="btn btn-primary mcp-add-btn" disabled>${escapeHtml(t('mcp.addPanel'))}</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  let tools: McpToolDef[] = [];
  let selectedTool: McpToolDef | null = existing
    ? { name: existing.toolName, description: '' }
    : null;

  const urlInput = modal.querySelector('.mcp-server-url') as HTMLInputElement;
  const authInput = modal.querySelector('.mcp-auth-header') as HTMLInputElement;
  const connectBtn = modal.querySelector('.mcp-connect-btn') as HTMLButtonElement;
  const connectStatus = modal.querySelector('.mcp-connect-status') as HTMLElement;
  const toolsSection = modal.querySelector('.mcp-tools-section') as HTMLElement;
  const toolsList = modal.querySelector('.mcp-tools-list') as HTMLElement;
  const toolConfig = modal.querySelector('.mcp-tool-config') as HTMLElement;
  const argsInput = modal.querySelector('.mcp-tool-args') as HTMLTextAreaElement;
  const argsError = modal.querySelector('.mcp-args-error') as HTMLElement;
  const titleInput = modal.querySelector('.mcp-panel-title') as HTMLInputElement;
  const refreshInput = modal.querySelector('.mcp-refresh-input') as HTMLInputElement;
  const addBtn = modal.querySelector('.mcp-add-btn') as HTMLButtonElement;

  // Pre-fill args if editing
  if (existing) {
    argsInput.value = Object.keys(existing.toolArgs).length
      ? JSON.stringify(existing.toolArgs, null, 2)
      : '{}';
    toolConfig.style.display = '';
    toolsSection.style.display = '';
    toolsList.innerHTML = `<div class="mcp-tool-item selected">${escapeHtml(existing.toolName)}</div>`;
    addBtn.disabled = false;
  }

  // Parse auth header input into Record<string,string>
  function parseAuthHeader(raw: string): Record<string, string> {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    const colon = trimmed.indexOf(':');
    if (colon === -1) return {};
    const key = trimmed.slice(0, colon).trim();
    const val = trimmed.slice(colon + 1).trim();
    if (!key) return {};
    return { [key]: val };
  }

  function renderTools(list: McpToolDef[]): void {
    toolsList.innerHTML = '';
    for (const tool of list) {
      const item = document.createElement('div');
      item.className = 'mcp-tool-item';
      item.innerHTML = `
        <span class="mcp-tool-name">${escapeHtml(tool.name)}</span>
        ${tool.description ? `<span class="mcp-tool-desc">${escapeHtml(tool.description)}</span>` : ''}
      `;
      item.addEventListener('click', () => {
        toolsList.querySelectorAll('.mcp-tool-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        selectedTool = tool;
        if (!titleInput.value) titleInput.value = tool.name;
        const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
        if (schema?.properties) {
          const defaults: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(schema.properties)) {
            const prop = v as { default?: unknown };
            if (prop.default !== undefined) defaults[k] = prop.default;
          }
          argsInput.value = JSON.stringify(defaults, null, 2) || '{}';
        } else {
          argsInput.value = '{}';
        }
        toolConfig.style.display = '';
        addBtn.disabled = false;
      });
      toolsList.appendChild(item);
    }
  }

  connectBtn.addEventListener('click', async () => {
    const serverUrl = urlInput.value.trim();
    if (!serverUrl) return;
    connectStatus.textContent = t('mcp.connecting');
    connectStatus.className = 'mcp-connect-status mcp-status-loading';
    connectBtn.disabled = true;
    try {
      const headers = parseAuthHeader(authInput.value);
      const qs = new URLSearchParams({ serverUrl });
      if (Object.keys(headers).length) qs.set('headers', JSON.stringify(headers));
      const resp = await fetch(`${proxyUrl('/api/mcp-proxy')}?${qs}`, {
        signal: AbortSignal.timeout(20_000),
      });
      const data = await resp.json() as { tools?: McpToolDef[]; error?: string };
      if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
      tools = data.tools ?? [];
      connectStatus.textContent = t('mcp.foundTools', { count: String(tools.length) });
      connectStatus.className = 'mcp-connect-status mcp-status-ok';
      toolsSection.style.display = '';
      renderTools(tools);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      connectStatus.textContent = `${t('mcp.connectFailed')}: ${msg}`;
      connectStatus.className = 'mcp-connect-status mcp-status-error';
    } finally {
      connectBtn.disabled = false;
    }
  });

  addBtn.addEventListener('click', () => {
    if (!selectedTool) return;
    argsError.style.display = 'none';
    let toolArgs: Record<string, unknown> = {};
    try {
      toolArgs = JSON.parse(argsInput.value || '{}') as Record<string, unknown>;
    } catch {
      argsError.textContent = t('mcp.invalidJson');
      argsError.style.display = '';
      return;
    }
    const id = existing?.id ?? `mcp-${crypto.randomUUID()}`;
    const spec: McpPanelSpec = {
      id,
      title: titleInput.value.trim() || selectedTool.name,
      serverUrl: urlInput.value.trim(),
      customHeaders: parseAuthHeader(authInput.value),
      toolName: selectedTool.name,
      toolArgs,
      refreshIntervalMs: Math.max(10, parseInt(refreshInput.value, 10) || 60) * 1000,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    closeMcpConnectModal();
    options.onComplete(spec);
  });

  const closeAndCancel = () => closeMcpConnectModal();
  modal.querySelector('.modal-close')?.addEventListener('click', closeAndCancel);
  modal.querySelector('.mcp-cancel-btn')?.addEventListener('click', closeAndCancel);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeAndCancel();
  });
}

function _headersToLine(headers: Record<string, string>): string {
  const entries = Object.entries(headers);
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}: ${v}`).join('; ');
}

export function closeMcpConnectModal(): void {
  overlay?.remove();
  overlay = null;
}
