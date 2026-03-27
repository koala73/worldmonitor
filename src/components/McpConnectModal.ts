import type { McpPanelSpec, McpPreset, McpToolDef } from '@/services/mcp-store';
import { MCP_PRESETS } from '@/services/mcp-store';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { proxyUrl } from '@/utils/proxy';
import { track } from '@/services/analytics';

interface McpConnectOptions {
  existingSpec?: McpPanelSpec;
  onComplete: (spec: McpPanelSpec) => void;
}

let overlay: HTMLElement | null = null;

/** Build a header Record from a template + key value.
 *  Template format: "Header-Name: prefix {key}" e.g. "Authorization: Bearer {key}" */
function buildHeadersFromTemplate(template: string, key: string): Record<string, string> {
  const colon = template.indexOf(':');
  if (colon === -1) return {};
  const headerName = template.slice(0, colon).trim();
  const headerValue = template.slice(colon + 1).trim().replace('{key}', key.trim());
  return { [headerName]: headerValue };
}

/** Extract the raw key value from existing headers using the preset template (for edit mode).
 *  Returns null if headers don't match the template. */
function extractKeyFromHeaders(headers: Record<string, string>, template: string): string | null {
  const colon = template.indexOf(':');
  if (colon === -1) return null;
  const headerName = template.slice(0, colon).trim();
  const valueTemplate = template.slice(colon + 1).trim(); // e.g. "Bearer {key}"
  const actual = headers[headerName];
  if (!actual) return null;
  const keyIdx = valueTemplate.indexOf('{key}');
  const prefix = valueTemplate.slice(0, keyIdx).trim();
  if (prefix && !actual.startsWith(prefix)) return null;
  return actual.slice(prefix ? prefix.length + 1 : 0).trim() || null;
}

/** Extract a short signup/docs hint from an authNote string.
 *  "Requires Authorization: Bearer <VAR> (free tier at exa.ai)" → "free tier at exa.ai" */
function extractAuthHint(authNote: string): string {
  const m = authNote.match(/\(([^)]+)\)\s*$/);
  return m?.[1] ?? authNote;
}

export function openMcpConnectModal(options: McpConnectOptions): void {
  closeMcpConnectModal();

  const existing = options.existingSpec;
  overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';

  const modal = document.createElement('div');
  modal.className = 'modal mcp-connect-modal';

  const presetsHtml = MCP_PRESETS.map(p => `
    <button class="mcp-preset-card" data-url="${escapeHtml(p.serverUrl)}"
      data-tool="${escapeHtml(p.defaultTool ?? '')}"
      data-args="${escapeHtml(JSON.stringify(p.defaultArgs ?? {}))}"
      data-title="${escapeHtml(p.defaultTitle ?? p.name)}"
      data-auth-note="${escapeHtml(p.authNote ?? '')}"
      data-api-key-header="${escapeHtml(p.apiKeyHeader ?? '')}">
      <span class="mcp-preset-icon">${p.icon}</span>
      <span class="mcp-preset-info">
        <span class="mcp-preset-name">${escapeHtml(p.name)}</span>
        <span class="mcp-preset-desc">${escapeHtml(p.description)}</span>
      </span>
      ${p.authNote ? '<span class="mcp-preset-key-badge">🔑</span>' : ''}
    </button>
  `).join('');

  // Determine initial auth mode for edit flow
  const existingHeaders = existing?.customHeaders ?? {};
  const matchingPreset: McpPreset | undefined = existing
    ? MCP_PRESETS.find(p => p.serverUrl === existing.serverUrl && p.apiKeyHeader)
    : undefined;
  const editSimpleKey = matchingPreset?.apiKeyHeader
    ? extractKeyFromHeaders(existingHeaders, matchingPreset.apiKeyHeader)
    : null;

  // New connections always open in simple API key mode; edit mode uses simple only if the
  // existing headers reverse-map cleanly to the preset's key template.
  const initialSimpleMode = !existing || !!editSimpleKey;
  const initialApiKey = editSimpleKey ?? '';
  const initialRawHeader = initialSimpleMode ? '' : _headersToLine(existingHeaders);

  modal.innerHTML = `
    <div class="modal-header">
      <span class="modal-title">${escapeHtml(t('mcp.modalTitle'))}</span>
      <button class="modal-close" aria-label="${escapeHtml(t('common.close'))}">\u2715</button>
    </div>
    <div class="mcp-connect-body">
      ${!existing ? `
      <div class="mcp-presets-section">
        <label class="mcp-label">${escapeHtml(t('mcp.quickConnect'))}</label>
        <div class="mcp-presets-list">${presetsHtml}</div>
      </div>
      <div class="mcp-section-divider"><span>${escapeHtml(t('mcp.or'))}</span></div>
      ` : ''}
      <div class="mcp-form-group">
        <label class="mcp-label">${escapeHtml(t('mcp.serverUrl'))}</label>
        <input class="mcp-input mcp-server-url" type="url"
          placeholder="https://my-mcp-server.com/mcp"
          value="${escapeHtml(existing?.serverUrl ?? '')}" />
      </div>
      <div class="mcp-form-group mcp-api-key-group" style="${initialSimpleMode ? '' : 'display:none'}">
        <label class="mcp-label">${escapeHtml(t('mcp.apiKey'))}</label>
        <input class="mcp-input mcp-api-key" type="text" autocomplete="off"
          placeholder="${escapeHtml(t('mcp.apiKeyPlaceholder'))}"
          value="${escapeHtml(initialApiKey)}" />
        <span class="mcp-api-key-hint"></span>
        <button type="button" class="mcp-auth-mode-btn mcp-to-advanced">${escapeHtml(t('mcp.useCustomHeaders'))}</button>
      </div>
      <div class="mcp-form-group mcp-auth-header-group" style="${initialSimpleMode ? 'display:none' : ''}">
        <label class="mcp-label">${escapeHtml(t('mcp.authHeader'))} <span class="mcp-optional">(${t('mcp.optional')})</span></label>
        <input class="mcp-input mcp-auth-header" type="text"
          placeholder="Authorization: Bearer token123; x-api-key: key456"
          value="${escapeHtml(initialRawHeader)}" />
        <button type="button" class="mcp-auth-mode-btn mcp-to-simple" style="display:none">${escapeHtml(t('mcp.useApiKey'))}</button>
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
  /** Template for the current preset, e.g. "Authorization: Bearer {key}".
   *  Falls back to a generic Bearer default so custom server key input works. */
  const DEFAULT_API_KEY_HEADER = 'Authorization: Bearer {key}';
  let activeApiKeyHeader = matchingPreset?.apiKeyHeader ?? (initialSimpleMode ? DEFAULT_API_KEY_HEADER : '');

  const urlInput = modal.querySelector('.mcp-server-url') as HTMLInputElement;
  const apiKeyGroup = modal.querySelector('.mcp-api-key-group') as HTMLElement;
  const apiKeyInput = modal.querySelector('.mcp-api-key') as HTMLInputElement;
  const apiKeyHint = modal.querySelector('.mcp-api-key-hint') as HTMLElement;
  const toAdvancedBtn = modal.querySelector('.mcp-to-advanced') as HTMLButtonElement;
  const authHeaderGroup = modal.querySelector('.mcp-auth-header-group') as HTMLElement;
  const authInput = modal.querySelector('.mcp-auth-header') as HTMLInputElement;
  const toSimpleBtn = modal.querySelector('.mcp-to-simple') as HTMLButtonElement;
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

  function isSimpleMode(): boolean {
    return apiKeyGroup.style.display !== 'none';
  }

  function getEffectiveHeaders(): Record<string, string> {
    if (isSimpleMode() && activeApiKeyHeader) {
      const key = apiKeyInput.value.trim();
      return key ? buildHeadersFromTemplate(activeApiKeyHeader, key) : {};
    }
    return parseAuthHeader(authInput.value);
  }

  function showSimpleMode(preset: McpPreset): void {
    activeApiKeyHeader = preset.apiKeyHeader ?? '';
    apiKeyGroup.style.display = '';
    authHeaderGroup.style.display = 'none';
    toSimpleBtn.style.display = 'none';
    if (preset.authNote) {
      apiKeyHint.textContent = extractAuthHint(preset.authNote);
    } else {
      apiKeyHint.textContent = '';
    }
  }

  function showAdvancedMode(prefillFromKey = true): void {
    if (prefillFromKey && activeApiKeyHeader && apiKeyInput.value.trim()) {
      authInput.value = _headersToLine(buildHeadersFromTemplate(activeApiKeyHeader, apiKeyInput.value.trim()));
    }
    apiKeyGroup.style.display = 'none';
    authHeaderGroup.style.display = '';
    if (activeApiKeyHeader) toSimpleBtn.style.display = '';
  }

  toAdvancedBtn.addEventListener('click', () => showAdvancedMode(true));
  toSimpleBtn.addEventListener('click', () => {
    // Re-extract key from any edits made in advanced mode
    if (activeApiKeyHeader) {
      const parsed = parseAuthHeader(authInput.value);
      const extracted = extractKeyFromHeaders(parsed, activeApiKeyHeader);
      if (extracted) apiKeyInput.value = extracted;
    }
    apiKeyGroup.style.display = '';
    authHeaderGroup.style.display = 'none';
    toSimpleBtn.style.display = 'none';
  });

  // Set hint if editing in simple mode
  if (initialSimpleMode && matchingPreset?.authNote) {
    apiKeyHint.textContent = extractAuthHint(matchingPreset.authNote);
  }

  // When user manually edits the URL: deselect presets and switch to generic simple mode.
  // Only applies in add mode — edit mode has no preset cards and manages its own auth state.
  if (!existing) {
    urlInput.addEventListener('input', () => {
      const typed = urlInput.value.trim();
      const presetCards = Array.from(modal.querySelectorAll<HTMLElement>('.mcp-preset-card'));
      const matchedCard = presetCards.find(c => c.dataset.url === typed);
      if (matchedCard) {
        // Re-select if user typed back an exact preset URL
        presetCards.forEach(c => c.classList.remove('selected'));
        matchedCard.classList.add('selected');
        const cardApiKeyHeader = matchedCard.dataset.apiKeyHeader ?? '';
        const cardAuthNote = matchedCard.dataset.authNote ?? '';
        const fakePreset = { apiKeyHeader: cardApiKeyHeader, authNote: cardAuthNote } as McpPreset;
        if (cardApiKeyHeader) {
          showSimpleMode(fakePreset);
        } else {
          activeApiKeyHeader = '';
          apiKeyGroup.style.display = 'none';
          apiKeyHint.textContent = '';
          authHeaderGroup.style.display = '';
          toSimpleBtn.style.display = 'none';
        }
      } else {
        presetCards.forEach(c => c.classList.remove('selected'));
        activeApiKeyHeader = DEFAULT_API_KEY_HEADER;
        apiKeyGroup.style.display = '';
        apiKeyHint.textContent = '';
        authHeaderGroup.style.display = 'none';
        toSimpleBtn.style.display = 'none';
      }
    });
  }

  // Preset card click handlers
  modal.querySelectorAll<HTMLElement>('.mcp-preset-card').forEach(card => {
    card.addEventListener('click', () => {
      modal.querySelectorAll('.mcp-preset-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      urlInput.value = card.dataset.url ?? '';

      const cardApiKeyHeader = card.dataset.apiKeyHeader ?? '';
      const cardAuthNote = card.dataset.authNote ?? '';

      if (cardApiKeyHeader) {
        const fakePreset = { apiKeyHeader: cardApiKeyHeader, authNote: cardAuthNote } as McpPreset;
        showSimpleMode(fakePreset);
        apiKeyInput.value = '';
        connectStatus.textContent = '';
        connectStatus.className = 'mcp-connect-status';
      } else {
        activeApiKeyHeader = '';
        apiKeyGroup.style.display = 'none';
        authHeaderGroup.style.display = '';
        toSimpleBtn.style.display = 'none';
        authInput.value = '';
        if (cardAuthNote) {
          connectStatus.textContent = `\u{1f511} ${cardAuthNote}`;
          connectStatus.className = 'mcp-connect-status mcp-status-info';
        } else {
          connectStatus.textContent = '';
          connectStatus.className = 'mcp-connect-status';
        }
      }

      // Pre-fill tool config if preset has defaults
      const presetTool = card.dataset.tool;
      const presetArgs = card.dataset.args;
      const presetTitle = card.dataset.title;
      if (presetTool) {
        selectedTool = { name: presetTool, description: '' };
        argsInput.value = presetArgs || '{}';
        if (presetTitle) titleInput.value = presetTitle;
        toolConfig.style.display = '';
        addBtn.disabled = false;
        toolsSection.style.display = '';
        toolsList.innerHTML = `<div class="mcp-tool-item selected"><span class="mcp-tool-name">${escapeHtml(presetTool)}</span></div>`;
      }
    });
  });

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

  function parseAuthHeader(raw: string): Record<string, string> {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    const result: Record<string, string> = {};
    for (const part of trimmed.split(/;\s+(?=[A-Za-z0-9_-]+\s*:)/)) {
      const colon = part.indexOf(':');
      if (colon === -1) continue;
      const key = part.slice(0, colon).trim();
      const val = part.slice(colon + 1).trim();
      if (key) result[key] = val;
    }
    return result;
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
    track('mcp-connect-attempt');
    connectStatus.textContent = t('mcp.connecting');
    connectStatus.className = 'mcp-connect-status mcp-status-loading';
    connectBtn.disabled = true;
    try {
      const headers = getEffectiveHeaders();
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
      track('mcp-connect-success', { toolCount: tools.length });
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
    track('mcp-panel-add', { tool: selectedTool.name });
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
      customHeaders: getEffectiveHeaders(),
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
