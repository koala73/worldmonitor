import './styles/main.css';
import './styles/settings-window.css';
import { RuntimeConfigPanel } from '@/components/RuntimeConfigPanel';
import { WorldMonitorTab } from '@/components/WorldMonitorTab';
import { RUNTIME_FEATURES, loadDesktopSecrets } from '@/services/runtime-config';
import { getApiBaseUrl, resolveLocalApiPort } from '@/services/runtime';
import { tryInvokeTauri } from '@/services/tauri-bridge';
import { escapeHtml } from '@/utils/sanitize';
import { initI18n, t } from '@/services/i18n';
import { applyStoredTheme } from '@/utils/theme-manager';

let diagnosticsInitialized = false;

function setActionStatus(message: string, tone: 'ok' | 'error' = 'ok'): void {
  const statusEl = document.getElementById('settingsActionStatus');
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.classList.remove('ok', 'error');
  statusEl.classList.add(tone);
}

async function invokeDesktopAction(command: string, successLabel: string): Promise<void> {
  const result = await tryInvokeTauri<string>(command);
  if (result) {
    setActionStatus(`${successLabel}: ${result}`, 'ok');
    return;
  }

  setActionStatus(t('modals.settingsWindow.invokeFail', { command }), 'error');
}

function initTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.settings-tab');
  const panels = document.querySelectorAll<HTMLElement>('.settings-tab-panel');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      if (!target) return;

      tabs.forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      panels.forEach((p) => p.classList.remove('active'));

      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');

      const panelId = tab.getAttribute('aria-controls');
      if (panelId) {
        document.getElementById(panelId)?.classList.add('active');
      }

      if (target === 'debug' && !diagnosticsInitialized) {
        diagnosticsInitialized = true;
        initDiagnostics();
      }
    });
  });
}

function closeSettingsWindow(): void {
  void tryInvokeTauri<void>('close_settings_window').then(() => { }, () => window.close());
}

const LLM_FEATURES: Array<import('@/services/runtime-config').RuntimeFeatureId> = ['aiOllama', 'aiGroq', 'aiOpenRouter'];

function mountPanel(panel: RuntimeConfigPanel, container: HTMLElement): void {
  container.innerHTML = '';
  const el = panel.getElement();
  el.classList.remove('resized', 'span-2', 'span-3', 'span-4');
  el.classList.add('settings-runtime-panel');
  container.appendChild(el);
}

async function initSettingsWindow(): Promise<void> {
  await initI18n();
  applyStoredTheme();

  // Prime sidecar port before any diagnostics or sidecar calls.
  // This sets _resolvedPort in runtime.ts so getApiBaseUrl() returns the
  // correct port for all callers (including runtime-config.ts).
  try { await resolveLocalApiPort(); } catch { /* use default */ }

  requestAnimationFrame(() => {
    document.documentElement.classList.remove('no-transition');
  });

  const llmMount = document.getElementById('llmApp');
  const apiMount = document.getElementById('apiKeysApp');
  const wmMount = document.getElementById('worldmonitorApp');
  if (!llmMount || !apiMount) return;

  // Mount WorldMonitor tab immediately — it doesn't depend on secrets
  const wmTab = new WorldMonitorTab();
  if (wmMount) {
    wmMount.innerHTML = '';
    wmMount.appendChild(wmTab.getElement());
  }

  // Load secrets then refresh WorldMonitor tab to reflect actual key status
  await loadDesktopSecrets();
  wmTab.refresh();

  const llmPanel = new RuntimeConfigPanel({ mode: 'full', buffered: true, featureFilter: LLM_FEATURES });
  const apiPanel = new RuntimeConfigPanel({
    mode: 'full',
    buffered: true,
    featureFilter: RUNTIME_FEATURES.filter(f => !LLM_FEATURES.includes(f.id)).map(f => f.id),
  });

  mountPanel(llmPanel, llmMount);
  mountPanel(apiPanel, apiMount);

  const panels = [llmPanel, apiPanel];

  window.addEventListener('beforeunload', () => {
    panels.forEach(p => p.destroy());
    wmTab.destroy();
  });

  document.getElementById('okBtn')?.addEventListener('click', () => {
    void (async () => {
      try {
        const hasWmChanges = wmTab.hasPendingChanges();
        const dirtyPanels = panels.filter(p => p.hasPendingChanges());

        if (dirtyPanels.length === 0 && !hasWmChanges) {
          closeSettingsWindow();
          return;
        }

        if (hasWmChanges) await wmTab.save();

        if (dirtyPanels.length > 0) {
          setActionStatus(t('modals.settingsWindow.validating'), 'ok');
          const missingRequired = dirtyPanels.flatMap(p => p.getMissingRequiredSecrets());
          if (missingRequired.length > 0) {
            setActionStatus(`Missing required: ${missingRequired.join(', ')}`, 'error');
            return;
          }
          const allErrors = (await Promise.all(dirtyPanels.map(p => p.verifyPendingSecrets()))).flat();
          await Promise.all(dirtyPanels.map(p => p.commitVerifiedSecrets()));
          if (allErrors.length > 0) {
            setActionStatus(t('modals.settingsWindow.verifyFailed', { errors: allErrors.join(', ') }), 'error');
            return;
          }
        }

        setActionStatus(t('modals.settingsWindow.saved'), 'ok');
        closeSettingsWindow();
      } catch (err) {
        console.error('[settings] save error:', err);
        setActionStatus(t('modals.settingsWindow.failed', { error: String(err) }), 'error');
      }
    })();
  });

  document.getElementById('cancelBtn')?.addEventListener('click', () => {
    closeSettingsWindow();
  });

  document.getElementById('openLogsBtn')?.addEventListener('click', () => {
    void invokeDesktopAction('open_logs_folder', t('modals.settingsWindow.openLogs'));
  });

  document.getElementById('openSidecarLogBtn')?.addEventListener('click', () => {
    void invokeDesktopAction('open_sidecar_log_file', t('modals.settingsWindow.openApiLog'));
  });

  initTabs();
}

function getSidecarBase(): string {
  return getApiBaseUrl() || 'http://127.0.0.1:46123';
}

let _diagToken: string | null = null;

async function diagFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!_diagToken) {
    try {
      _diagToken = await tryInvokeTauri<string>('get_local_api_token');
    } catch { /* token unavailable */ }
  }
  const headers = new Headers(init?.headers);
  if (_diagToken) headers.set('Authorization', `Bearer ${_diagToken}`);
  return fetch(`${getSidecarBase()}${path}`, { ...init, headers });
}

function initDiagnostics(): void {
  const verboseToggle = document.getElementById('verboseApiLog') as HTMLInputElement | null;
  const fetchDebugToggle = document.getElementById('fetchDebugLog') as HTMLInputElement | null;
  const autoRefreshToggle = document.getElementById('autoRefreshLog') as HTMLInputElement | null;
  const refreshBtn = document.getElementById('refreshLogBtn');
  const clearBtn = document.getElementById('clearLogBtn');
  const trafficLogEl = document.getElementById('trafficLog');
  const trafficCount = document.getElementById('trafficCount');

  if (fetchDebugToggle) {
    fetchDebugToggle.checked = localStorage.getItem('wm-debug-log') === '1';
    fetchDebugToggle.addEventListener('change', () => {
      localStorage.setItem('wm-debug-log', fetchDebugToggle.checked ? '1' : '0');
    });
  }

  async function syncVerboseState(): Promise<void> {
    if (!verboseToggle) return;
    try {
      const res = await diagFetch('/api/local-debug-toggle');
      const data = await res.json();
      verboseToggle.checked = data.verboseMode;
    } catch { /* sidecar not running */ }
  }

  verboseToggle?.addEventListener('change', async () => {
    try {
      const res = await diagFetch('/api/local-debug-toggle', { method: 'POST' });
      const data = await res.json();
      if (verboseToggle) verboseToggle.checked = data.verboseMode;
      setActionStatus(data.verboseMode ? t('modals.settingsWindow.verboseOn') : t('modals.settingsWindow.verboseOff'), 'ok');
    } catch {
      setActionStatus(t('modals.settingsWindow.sidecarError'), 'error');
    }
  });

  void syncVerboseState();

  async function refreshTrafficLog(): Promise<void> {
    if (!trafficLogEl) return;
    try {
      const res = await diagFetch('/api/local-traffic-log');
      const data = await res.json();
      const entries: Array<{ timestamp: string; method: string; path: string; status: number; durationMs: number }> = data.entries || [];
      if (trafficCount) trafficCount.textContent = `(${entries.length})`;

      if (entries.length === 0) {
        trafficLogEl.innerHTML = `<p class="diag-empty">${t('modals.settingsWindow.noTraffic')}</p>`;
        return;
      }

      const rows = entries.slice().reverse().map((e) => {
        const ts = e.timestamp.split('T')[1]?.replace('Z', '') || e.timestamp;
        const cls = e.status < 300 ? 'ok' : e.status < 500 ? 'warn' : 'err';
        return `<tr class="diag-${cls}"><td>${escapeHtml(ts)}</td><td>${e.method}</td><td title="${escapeHtml(e.path)}">${escapeHtml(e.path)}</td><td>${e.status}</td><td>${e.durationMs}ms</td></tr>`;
      }).join('');

      trafficLogEl.innerHTML = `<table class="diag-table"><thead><tr><th>${t('modals.settingsWindow.table.time')}</th><th>${t('modals.settingsWindow.table.method')}</th><th>${t('modals.settingsWindow.table.path')}</th><th>${t('modals.settingsWindow.table.status')}</th><th>${t('modals.settingsWindow.table.duration')}</th></tr></thead><tbody>${rows}</tbody></table>`;
    } catch {
      trafficLogEl.innerHTML = `<p class="diag-empty">${t('modals.settingsWindow.sidecarUnreachable')}</p>`;
    }
  }

  refreshBtn?.addEventListener('click', () => void refreshTrafficLog());

  clearBtn?.addEventListener('click', async () => {
    try {
      await diagFetch('/api/local-traffic-log', { method: 'DELETE' });
    } catch { /* ignore */ }
    if (trafficLogEl) trafficLogEl.innerHTML = `<p class="diag-empty">${t('modals.settingsWindow.logCleared')}</p>`;
    if (trafficCount) trafficCount.textContent = '(0)';
  });

  let refreshInterval: ReturnType<typeof setInterval> | null = null;

  function startAutoRefresh(): void {
    stopAutoRefresh();
    refreshInterval = setInterval(() => void refreshTrafficLog(), 3000);
  }

  function stopAutoRefresh(): void {
    if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
  }

  autoRefreshToggle?.addEventListener('change', () => {
    if (autoRefreshToggle.checked) startAutoRefresh(); else stopAutoRefresh();
  });

  void refreshTrafficLog();
  startAutoRefresh();
}

// Signal main window that settings is open (suppresses alert popups)
localStorage.setItem('wm-settings-open', '1');
window.addEventListener('beforeunload', () => localStorage.removeItem('wm-settings-open'));

void initSettingsWindow();
