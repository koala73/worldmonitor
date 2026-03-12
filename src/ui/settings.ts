import type { ThemePreference, FontSize, AIProviderConfig } from '@/types/news-reader';
import { PROVIDER_URLS } from '@/types/news-reader';
import { getSettings, updateSettings, getAIConfig, saveAIConfig } from '@/services/settings-store';
import { getCategories } from '@/ingestion/feeds';
import { el, clear } from './helpers';

export function renderSettings(container: HTMLElement): void {
  clear(container);

  const wrapper = el('div', { className: 'settings-page' });
  wrapper.append(el('h2', { className: 'settings-title' }, 'Settings'));

  wrapper.append(renderAppearanceSection());
  wrapper.append(renderFeedsSection());
  wrapper.append(renderAISection());
  wrapper.append(renderDataSection());

  container.append(wrapper);
}

// ── Appearance ───────────────────────────────────────────────────────────────

function renderAppearanceSection(): HTMLElement {
  const settings = getSettings();
  const section = el('div', { className: 'settings-section' });
  section.append(el('h3', { className: 'section-title' }, 'Appearance'));

  // Theme
  const themeRow = settingRow('Theme');
  const themeSelect = el('select', { className: 'setting-select' });
  for (const opt of ['dark', 'light'] as ThemePreference[]) {
    const o = el('option', { value: opt }, opt.charAt(0).toUpperCase() + opt.slice(1));
    if (settings.theme === opt) o.selected = true;
    themeSelect.append(o);
  }
  themeSelect.addEventListener('change', () => {
    const val = themeSelect.value as ThemePreference;
    updateSettings({ theme: val });
    document.documentElement.dataset.theme = val;
    localStorage.setItem('newsreader-theme', val);
  });
  themeRow.append(themeSelect);
  section.append(themeRow);

  // Font Size
  const fontRow = settingRow('Font Size');
  const fontSelect = el('select', { className: 'setting-select' });
  for (const opt of ['small', 'medium', 'large'] as FontSize[]) {
    const o = el('option', { value: opt }, opt.charAt(0).toUpperCase() + opt.slice(1));
    if (settings.fontSize === opt) o.selected = true;
    fontSelect.append(o);
  }
  fontSelect.addEventListener('change', () => {
    const val = fontSelect.value as FontSize;
    updateSettings({ fontSize: val });
    document.documentElement.dataset.fontsize = val;
  });
  fontRow.append(fontSelect);
  section.append(fontRow);

  return section;
}

// ── Feeds ────────────────────────────────────────────────────────────────────

function renderFeedsSection(): HTMLElement {
  const settings = getSettings();
  const section = el('div', { className: 'settings-section' });
  section.append(el('h3', { className: 'section-title' }, 'Feeds'));

  // Refresh interval
  const refreshRow = settingRow('Refresh Interval (min)');
  const refreshInput = el('input', {
    type: 'number',
    value: settings.feedRefreshInterval.toString(),
    className: 'setting-input',
  });
  refreshInput.min = '1';
  refreshInput.max = '60';
  refreshInput.addEventListener('change', () => {
    const val = Math.max(1, Math.min(60, parseInt(refreshInput.value) || 5));
    updateSettings({ feedRefreshInterval: val });
  });
  refreshRow.append(refreshInput);
  section.append(refreshRow);

  // Clustering sensitivity
  const clusterRow = settingRow('Clustering Sensitivity');
  const clusterInput = el('input', {
    type: 'range',
    className: 'setting-range',
  });
  clusterInput.min = '0.3';
  clusterInput.max = '0.9';
  clusterInput.step = '0.1';
  clusterInput.value = settings.clusteringSensitivity.toString();
  const clusterVal = el('span', { className: 'range-value' }, settings.clusteringSensitivity.toString());
  clusterInput.addEventListener('input', () => {
    clusterVal.textContent = clusterInput.value;
    updateSettings({ clusteringSensitivity: parseFloat(clusterInput.value) });
  });
  clusterRow.append(clusterInput, clusterVal);
  section.append(clusterRow);

  // Category checkboxes
  const catLabel = el('div', { className: 'setting-row-full' });
  catLabel.append(el('label', { className: 'setting-label' }, 'Enabled Categories'));
  const catGrid = el('div', { className: 'cat-checkbox-grid' });
  const allCats = getCategories();
  const enabled = new Set(settings.enabledCategories);

  for (const cat of allCats) {
    const id = `cat-${cat}`;
    const cb = el('input', { type: 'checkbox', id });
    cb.checked = enabled.size === 0 || enabled.has(cat);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        enabled.add(cat);
      } else {
        enabled.delete(cat);
      }
      updateSettings({ enabledCategories: [...enabled] });
    });
    const lbl = el('label', { htmlFor: id, className: 'cat-label' },
      cb,
      ` ${cat.charAt(0).toUpperCase() + cat.slice(1)}`,
    );
    catGrid.append(lbl);
  }
  catLabel.append(catGrid);
  section.append(catLabel);

  return section;
}

// ── AI Provider ──────────────────────────────────────────────────────────────

function renderAISection(): HTMLElement {
  const config = getAIConfig();
  const section = el('div', { className: 'settings-section' });
  section.append(el('h3', { className: 'section-title' }, 'AI Provider'));

  // Provider select
  const providerRow = settingRow('Provider');
  const providerSelect = el('select', { className: 'setting-select' });
  for (const p of Object.keys(PROVIDER_URLS)) {
    const o = el('option', { value: p }, p.charAt(0).toUpperCase() + p.slice(1));
    if (config.provider === p) o.selected = true;
    providerSelect.append(o);
  }
  const customOpt = el('option', { value: 'custom' }, 'Custom');
  if (config.provider === 'custom') customOpt.selected = true;
  providerSelect.append(customOpt);
  providerRow.append(providerSelect);
  section.append(providerRow);

  // Base URL
  const urlRow = settingRow('Base URL');
  const urlInput = el('input', {
    type: 'text',
    value: config.baseUrl,
    className: 'setting-input wide',
    placeholder: 'https://api.openai.com/v1',
  });
  urlRow.append(urlInput);
  section.append(urlRow);

  providerSelect.addEventListener('change', () => {
    const p = providerSelect.value;
    if (p !== 'custom' && PROVIDER_URLS[p]) {
      urlInput.value = PROVIDER_URLS[p];
    }
  });

  // API Key
  const keyRow = settingRow('API Key');
  const keyInput = el('input', {
    type: 'password',
    value: config.apiKey,
    className: 'setting-input wide',
    placeholder: 'sk-...',
  });
  keyRow.append(keyInput);
  section.append(keyRow);

  // Model
  const modelRow = settingRow('Model');
  const modelInput = el('input', {
    type: 'text',
    value: config.model,
    className: 'setting-input',
    placeholder: 'gpt-4o-mini',
  });
  modelRow.append(modelInput);
  section.append(modelRow);

  // Max tokens
  const tokensRow = settingRow('Max Tokens');
  const tokensInput = el('input', {
    type: 'number',
    value: config.maxTokens.toString(),
    className: 'setting-input',
  });
  tokensInput.min = '50';
  tokensInput.max = '2000';
  tokensRow.append(tokensInput);
  section.append(tokensRow);

  // Auto-narrate toggle
  const settings = getSettings();
  const autoRow = settingRow('Auto-Narrate Top 5');
  const autoCheck = el('input', { type: 'checkbox' });
  autoCheck.checked = settings.autoNarrate;
  autoCheck.addEventListener('change', () => {
    updateSettings({ autoNarrate: autoCheck.checked });
  });
  autoRow.append(autoCheck);
  section.append(autoRow);

  // Save button
  const saveBtn = el('button', { className: 'btn-primary' }, 'Save AI Config');
  saveBtn.addEventListener('click', () => {
    const updated: AIProviderConfig = {
      provider: providerSelect.value,
      apiKey: keyInput.value,
      baseUrl: urlInput.value,
      model: modelInput.value,
      maxTokens: Math.max(50, parseInt(tokensInput.value) || 300),
      validated: false,
    };
    saveAIConfig(updated);
    saveBtn.textContent = 'Saved!';
    setTimeout(() => { saveBtn.textContent = 'Save AI Config'; }, 2000);
  });
  section.append(saveBtn);

  return section;
}

// ── Data Management ──────────────────────────────────────────────────────────

function renderDataSection(): HTMLElement {
  const section = el('div', { className: 'settings-section' });
  section.append(el('h3', { className: 'section-title' }, 'Data Management'));

  const desc = el('p', { className: 'text-muted' },
    'All data is stored locally in your browser using IndexedDB.');
  section.append(desc);

  const clearBtn = el('button', { className: 'btn-danger' }, 'Clear All Data');
  clearBtn.addEventListener('click', async () => {
    if (!confirm('This will delete all stories, clusters, and narrations. Continue?')) return;
    try {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
      clearBtn.textContent = 'Cleared! Reloading...';
      setTimeout(() => location.reload(), 1000);
    } catch {
      clearBtn.textContent = 'Error clearing data';
    }
  });
  section.append(clearBtn);

  // Debug mode
  const settings = getSettings();
  const debugRow = settingRow('Debug Mode');
  const debugCheck = el('input', { type: 'checkbox' });
  debugCheck.checked = settings.debugMode;
  debugCheck.addEventListener('change', () => {
    updateSettings({ debugMode: debugCheck.checked });
  });
  debugRow.append(debugCheck);
  section.append(debugRow);

  return section;
}

// ── Helper ───────────────────────────────────────────────────────────────────

function settingRow(label: string): HTMLElement {
  const row = el('div', { className: 'setting-row' });
  row.append(el('label', { className: 'setting-label' }, label));
  return row;
}
