import { Panel } from './Panel';
import {
  RUNTIME_FEATURES,
  getEffectiveSecrets,
  getRuntimeConfigSnapshot,
  getSecretState,
  isFeatureAvailable,
  isFeatureEnabled,
  setFeatureToggle,
  setSecretValue,
  subscribeRuntimeConfig,
  validateSecret,
  verifySecretWithApi,
  type RuntimeFeatureDefinition,
  type RuntimeFeatureId,
  type RuntimeSecretKey,
} from '@/services/runtime-config';
import { invokeTauri } from '@/services/tauri-bridge';
import { escapeHtml } from '@/utils/sanitize';
import { isDesktopRuntime } from '@/services/runtime';
import { t } from '@/services/i18n';
import { trackFeatureToggle } from '@/services/analytics';

const SIGNUP_URLS: Partial<Record<RuntimeSecretKey, string>> = {
  GROQ_API_KEY: 'https://console.groq.com/keys',
  OPENROUTER_API_KEY: 'https://openrouter.ai/settings/keys',
  FRED_API_KEY: 'https://fred.stlouisfed.org/docs/api/api_key.html',
  EIA_API_KEY: 'https://www.eia.gov/opendata/register.php',
  CLOUDFLARE_API_TOKEN: 'https://dash.cloudflare.com/profile/api-tokens',
  ACLED_ACCESS_TOKEN: 'https://developer.acleddata.com/',
  URLHAUS_AUTH_KEY: 'https://auth.abuse.ch/',
  OTX_API_KEY: 'https://otx.alienvault.com/',
  ABUSEIPDB_API_KEY: 'https://www.abuseipdb.com/login',
  WINGBITS_API_KEY: 'https://wingbits.com/register',
  AISSTREAM_API_KEY: 'https://aisstream.io/authenticate',
  OPENSKY_CLIENT_ID: 'https://opensky-network.org/login?view=registration',
  OPENSKY_CLIENT_SECRET: 'https://opensky-network.org/login?view=registration',
  FINNHUB_API_KEY: 'https://finnhub.io/register',
  NASA_FIRMS_API_KEY: 'https://firms.modaps.eosdis.nasa.gov/api/area/',
  UC_DP_KEY: 'https://ucdp.uu.se/downloads/',
  OLLAMA_API_URL: 'https://ollama.com/download',
  OLLAMA_MODEL: 'https://ollama.com/library',
};

const PLAINTEXT_KEYS = new Set<RuntimeSecretKey>([
  'OLLAMA_API_URL',
  'OLLAMA_MODEL',
  'WS_RELAY_URL',
  'VITE_OPENSKY_RELAY_URL',
]);

const MASKED_SENTINEL = '__WM_MASKED__';

interface RuntimeConfigPanelOptions {
  mode?: 'full' | 'alert';
  buffered?: boolean;
  featureFilter?: RuntimeFeatureId[];
}

export class RuntimeConfigPanel extends Panel {
  private unsubscribe: (() => void) | null = null;
  private readonly mode: 'full' | 'alert';
  private readonly buffered: boolean;
  private readonly featureFilter?: RuntimeFeatureId[];
  private pendingSecrets = new Map<RuntimeSecretKey, string>();
  private validatedKeys = new Map<RuntimeSecretKey, boolean>();
  private validationMessages = new Map<RuntimeSecretKey, string>();

  constructor(options: RuntimeConfigPanelOptions = {}) {
    super({ id: 'runtime-config', title: t('modals.runtimeConfig.title'), showCount: false });
    this.mode = options.mode ?? (isDesktopRuntime() ? 'alert' : 'full');
    this.buffered = options.buffered ?? false;
    this.featureFilter = options.featureFilter;
    this.unsubscribe = subscribeRuntimeConfig(() => this.render());
    this.render();
  }

  public async commitPendingSecrets(): Promise<void> {
    for (const [key, value] of this.pendingSecrets) {
      await setSecretValue(key, value);
    }
    this.pendingSecrets.clear();
    this.validatedKeys.clear();
    this.validationMessages.clear();
  }

  public async commitVerifiedSecrets(): Promise<void> {
    for (const [key, value] of this.pendingSecrets) {
      if (this.validatedKeys.get(key) !== false) {
        await setSecretValue(key, value);
        this.pendingSecrets.delete(key);
        this.validatedKeys.delete(key);
        this.validationMessages.delete(key);
      }
    }
  }

  public hasPendingChanges(): boolean {
    return this.pendingSecrets.size > 0;
  }

  private getFilteredFeatures(): RuntimeFeatureDefinition[] {
    return this.featureFilter
      ? RUNTIME_FEATURES.filter(f => this.featureFilter!.includes(f.id))
      : RUNTIME_FEATURES;
  }

  /** Returns missing required secrets for enabled features that have at least one pending key. */
  public getMissingRequiredSecrets(): string[] {
    const missing: string[] = [];
    for (const feature of this.getFilteredFeatures()) {
      if (!isFeatureEnabled(feature.id)) continue;
      const secrets = getEffectiveSecrets(feature);
      const hasPending = secrets.some(k => this.pendingSecrets.has(k));
      if (!hasPending) continue;
      for (const key of secrets) {
        if (!getSecretState(key).valid && !this.pendingSecrets.has(key)) {
          missing.push(key);
        }
      }
    }
    return missing;
  }

  public getValidationErrors(): string[] {
    const errors: string[] = [];
    for (const [key, value] of this.pendingSecrets) {
      const result = validateSecret(key, value);
      if (!result.valid) errors.push(`${key}: ${result.hint || 'Invalid format'}`);
    }
    return errors;
  }

  public async verifyPendingSecrets(): Promise<string[]> {
    this.captureUnsavedInputs();
    const errors: string[] = [];
    const context = Object.fromEntries(this.pendingSecrets.entries()) as Partial<Record<RuntimeSecretKey, string>>;

    // Split into local-only failures vs keys needing remote verification
    const toVerifyRemotely: Array<[RuntimeSecretKey, string]> = [];
    for (const [key, value] of this.pendingSecrets) {
      const localResult = validateSecret(key, value);
      if (!localResult.valid) {
        this.validatedKeys.set(key, false);
        this.validationMessages.set(key, localResult.hint || 'Invalid format');
        errors.push(`${key}: ${localResult.hint || 'Invalid format'}`);
      } else {
        toVerifyRemotely.push([key, value]);
      }
    }

    // Run all remote verifications in parallel with a 15s global timeout
    if (toVerifyRemotely.length > 0) {
      const results = await Promise.race([
        Promise.all(toVerifyRemotely.map(async ([key, value]) => {
          const result = await verifySecretWithApi(key, value, context);
          return { key, result };
        })),
        new Promise<Array<{ key: RuntimeSecretKey; result: { valid: boolean; message?: string } }>>(resolve =>
          setTimeout(() => resolve(toVerifyRemotely.map(([key]) => ({
            key, result: { valid: true, message: 'Saved (verification timed out)' },
          }))), 15000)
        ),
      ]);
      for (const { key, result: verifyResult } of results) {
        this.validatedKeys.set(key, verifyResult.valid);
        if (!verifyResult.valid) {
          this.validationMessages.set(key, verifyResult.message || 'Verification failed');
          errors.push(`${key}: ${verifyResult.message || 'Verification failed'}`);
        } else {
          this.validationMessages.delete(key);
        }
      }
    }

    if (this.pendingSecrets.size > 0) {
      this.render();
    }

    return errors;
  }

  public destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private captureUnsavedInputs(): void {
    if (!this.buffered) return;
    this.content.querySelectorAll<HTMLInputElement>('input[data-secret]').forEach((input) => {
      const key = input.dataset.secret as RuntimeSecretKey | undefined;
      if (!key) return;
      const raw = input.value.trim();
      if (!raw || raw === MASKED_SENTINEL) return;
      // Skip plaintext keys whose value hasn't changed from stored value
      if (PLAINTEXT_KEYS.has(key) && !this.pendingSecrets.has(key)) {
        const stored = getRuntimeConfigSnapshot().secrets[key]?.value || '';
        if (raw === stored) return;
      }
      this.pendingSecrets.set(key, raw);
      const result = validateSecret(key, raw);
      if (!result.valid) {
        this.validatedKeys.set(key, false);
        this.validationMessages.set(key, result.hint || 'Invalid format');
      }
    });
    // Capture model from select or manual input
    const modelSelect = this.content.querySelector<HTMLSelectElement>('select[data-model-select]');
    const modelManual = this.content.querySelector<HTMLInputElement>('input[data-model-manual]');
    const modelValue = (modelManual && !modelManual.classList.contains('hidden-input') ? modelManual.value.trim() : modelSelect?.value) || '';
    if (modelValue && !this.pendingSecrets.has('OLLAMA_MODEL')) {
      this.pendingSecrets.set('OLLAMA_MODEL', modelValue);
      this.validatedKeys.set('OLLAMA_MODEL', true);
    }
  }

  protected render(): void {
    this.captureUnsavedInputs();
    const snapshot = getRuntimeConfigSnapshot();
    const desktop = isDesktopRuntime();

    const features = this.getFilteredFeatures();

    if (desktop && this.mode === 'alert') {
      const totalFeatures = RUNTIME_FEATURES.length;
      const availableFeatures = RUNTIME_FEATURES.filter((feature) => isFeatureAvailable(feature.id)).length;
      const missingFeatures = Math.max(0, totalFeatures - availableFeatures);
      const configuredCount = Object.keys(snapshot.secrets).length;

      if (missingFeatures === 0 && configuredCount >= totalFeatures) {
        this.hide();
        return;
      }

      const alertTitle = configuredCount > 0
        ? (missingFeatures > 0 ? t('modals.runtimeConfig.alertTitle.some') : t('modals.runtimeConfig.alertTitle.configured'))
        : t('modals.runtimeConfig.alertTitle.needsKeys');
      const alertClass = missingFeatures > 0 ? 'warn' : 'ok';

      this.show();
      this.content.innerHTML = `
        <section class="runtime-alert runtime-alert-${alertClass}">
          <h3>${alertTitle}</h3>
          <p>
            ${availableFeatures}/${totalFeatures} ${t('modals.runtimeConfig.summary.available')}${configuredCount > 0 ? ` · ${configuredCount} ${t('modals.runtimeConfig.summary.secrets')}` : ''}.
          </p>
          <p class="runtime-alert-skip">${t('modals.runtimeConfig.skipSetup')}</p>
          <button type="button" class="runtime-open-settings-btn" data-open-settings>
            ${t('modals.runtimeConfig.openSettings')}
          </button>
        </section>
      `;
      this.attachListeners();
      return;
    }

    this.content.innerHTML = `
      <div class="runtime-config-summary">
        ${desktop ? t('modals.runtimeConfig.summary.desktop') : t('modals.runtimeConfig.summary.web')} · ${features.filter(f => isFeatureAvailable(f.id)).length}/${features.length} ${t('modals.runtimeConfig.summary.available')}
      </div>
      <div class="runtime-config-list">
        ${features.map(feature => this.renderFeature(feature)).join('')}
      </div>
    `;

    this.attachListeners();
  }

  private renderFeature(feature: RuntimeFeatureDefinition): string {
    const enabled = isFeatureEnabled(feature.id);
    const available = isFeatureAvailable(feature.id);
    const effectiveSecrets = getEffectiveSecrets(feature);
    const allStaged = !available && effectiveSecrets.every(
      (k) => getSecretState(k).valid || (this.pendingSecrets.has(k) && this.validatedKeys.get(k) !== false)
    );
    const pillClass = available ? 'ok' : allStaged ? 'staged' : 'warn';
    const pillLabel = available ? t('modals.runtimeConfig.status.ready') : allStaged ? t('modals.runtimeConfig.status.staged') : t('modals.runtimeConfig.status.needsKeys');
    const secrets = effectiveSecrets.map((key) => this.renderSecretRow(key)).join('');
    const desktop = isDesktopRuntime();
    const fallbackHtml = available || allStaged ? '' : `<p class="runtime-feature-fallback fallback">${escapeHtml(feature.fallback)}</p>`;

    return `
      <section class="runtime-feature ${available ? 'available' : allStaged ? 'staged' : 'degraded'}">
        <header class="runtime-feature-header">
          <label>
            <input type="checkbox" data-toggle="${feature.id}" ${enabled ? 'checked' : ''} ${desktop ? '' : 'disabled'}>
            <span>${escapeHtml(feature.name)}</span>
          </label>
          <span class="runtime-pill ${pillClass}">${pillLabel}</span>
        </header>
        <div class="runtime-secrets">${secrets}</div>
        ${fallbackHtml}
      </section>
    `;
  }

  private renderSecretRow(key: RuntimeSecretKey): string {
    const state = getSecretState(key);
    const pending = this.pendingSecrets.has(key);
    const pendingValid = pending ? this.validatedKeys.get(key) : undefined;
    const status = pending
      ? (pendingValid === false ? t('modals.runtimeConfig.status.invalid') : t('modals.runtimeConfig.status.staged'))
      : !state.present ? t('modals.runtimeConfig.status.missing') : state.valid ? t('modals.runtimeConfig.status.valid') : t('modals.runtimeConfig.status.looksInvalid');
    const statusClass = pending
      ? (pendingValid === false ? 'warn' : 'staged')
      : state.valid ? 'ok' : 'warn';
    const signupUrl = SIGNUP_URLS[key];
    const helpKey = `modals.runtimeConfig.help.${key}`;
    const helpRaw = t(helpKey);
    const helpText = helpRaw !== helpKey ? helpRaw : '';
    const linkHtml = signupUrl
      ? ` <a href="#" data-signup-url="${signupUrl}" class="runtime-secret-link" title="Get API key">&#x2197;</a>`
      : '';
    const validated = this.validatedKeys.get(key);
    const inputClass = pending ? (validated === false ? 'invalid' : 'valid-staged') : '';
    const checkClass = validated === true ? 'visible' : '';
    const hintText = pending && validated === false
      ? (this.validationMessages.get(key) || validateSecret(key, this.pendingSecrets.get(key) || '').hint || 'Invalid value')
      : null;

    if (key === 'OLLAMA_MODEL') {
      const storedModel = pending
        ? this.pendingSecrets.get(key) || ''
        : getRuntimeConfigSnapshot().secrets[key]?.value || '';
      return `
        <div class="runtime-secret-row">
          <div class="runtime-secret-key"><code>${escapeHtml(key)}</code></div>
          <span class="runtime-secret-status ${statusClass}">${escapeHtml(status)}</span>
          <span class="runtime-secret-check ${checkClass}">&#x2713;</span>
          ${helpText ? `<div class="runtime-secret-meta">${escapeHtml(helpText)}</div>` : ''}
          <select data-model-select class="${inputClass}" ${isDesktopRuntime() ? '' : 'disabled'}>
            ${storedModel ? `<option value="${escapeHtml(storedModel)}" selected>${escapeHtml(storedModel)}</option>` : '<option value="" selected disabled>Loading models...</option>'}
          </select>
          <input type="text" data-model-manual class="${inputClass} hidden-input" placeholder="Or type model name" autocomplete="off" ${isDesktopRuntime() ? '' : 'disabled'} ${storedModel ? `value="${escapeHtml(storedModel)}"` : ''}>
          ${hintText ? `<span class="runtime-secret-hint">${escapeHtml(hintText)}</span>` : ''}
        </div>
      `;
    }

    return `
      <div class="runtime-secret-row">
        <div class="runtime-secret-key"><code>${escapeHtml(key)}</code>${linkHtml}</div>
        <span class="runtime-secret-status ${statusClass}">${escapeHtml(status)}</span>
        <span class="runtime-secret-check ${checkClass}">&#x2713;</span>
        ${helpText ? `<div class="runtime-secret-meta">${escapeHtml(helpText)}</div>` : ''}
        <input type="${PLAINTEXT_KEYS.has(key) ? 'text' : 'password'}" data-secret="${key}" placeholder="${pending ? t('modals.runtimeConfig.placeholder.staged') : t('modals.runtimeConfig.placeholder.setSecret')}" autocomplete="off" ${isDesktopRuntime() ? '' : 'disabled'} class="${inputClass}" ${pending ? `value="${PLAINTEXT_KEYS.has(key) ? escapeHtml(this.pendingSecrets.get(key) || '') : MASKED_SENTINEL}"` : (PLAINTEXT_KEYS.has(key) && state.present ? `value="${escapeHtml(getRuntimeConfigSnapshot().secrets[key]?.value || '')}"` : '')}>
        ${hintText ? `<span class="runtime-secret-hint">${escapeHtml(hintText)}</span>` : ''}
      </div>
    `;
  }

  private attachListeners(): void {
    this.content.querySelectorAll<HTMLAnchorElement>('a[data-signup-url]').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const url = link.dataset.signupUrl;
        if (!url) return;
        if (isDesktopRuntime()) {
          void invokeTauri<void>('open_url', { url }).catch(() => window.open(url, '_blank'));
        } else {
          window.open(url, '_blank');
        }
      });
    });

    if (!isDesktopRuntime()) return;

    if (this.mode === 'alert') {
      this.content.querySelector<HTMLButtonElement>('[data-open-settings]')?.addEventListener('click', () => {
        void invokeTauri<void>('open_settings_window_command').catch((error) => {
          console.warn('[runtime-config] Failed to open settings window', error);
        });
      });
      return;
    }

    // Ollama model dropdown: fetch models and handle selection
    const modelSelect = this.content.querySelector<HTMLSelectElement>('select[data-model-select]');
    if (modelSelect) {
      modelSelect.addEventListener('change', () => {
        const model = modelSelect.value;
        if (model && this.buffered) {
          this.pendingSecrets.set('OLLAMA_MODEL', model);
          this.validatedKeys.set('OLLAMA_MODEL', true);
          modelSelect.classList.remove('invalid');
          modelSelect.classList.add('valid-staged');
          this.updateFeatureCardStatus('OLLAMA_MODEL');
        }
      });
      void this.fetchOllamaModels(modelSelect);
    }

    this.content.querySelectorAll<HTMLInputElement>('input[data-toggle]').forEach((input) => {
      input.addEventListener('change', () => {
        const featureId = input.dataset.toggle as RuntimeFeatureDefinition['id'] | undefined;
        if (!featureId) return;
        trackFeatureToggle(featureId, input.checked);
        setFeatureToggle(featureId, input.checked);
      });
    });

    this.content.querySelectorAll<HTMLInputElement>('input[data-secret]').forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.dataset.secret as RuntimeSecretKey | undefined;
        if (!key) return;
        if (this.buffered && this.pendingSecrets.has(key) && input.value.startsWith(MASKED_SENTINEL)) {
          input.value = input.value.slice(MASKED_SENTINEL.length);
        }
        this.validatedKeys.delete(key);
        this.validationMessages.delete(key);
        const check = input.closest('.runtime-secret-row')?.querySelector('.runtime-secret-check');
        check?.classList.remove('visible');
        input.classList.remove('valid-staged', 'invalid');
        const hint = input.closest('.runtime-secret-row')?.querySelector('.runtime-secret-hint');
        if (hint) hint.remove();
      });

      input.addEventListener('blur', () => {
        const key = input.dataset.secret as RuntimeSecretKey | undefined;
        if (!key) return;
        const raw = input.value.trim();
        if (!raw) {
          if (this.buffered && this.pendingSecrets.has(key)) {
            this.pendingSecrets.delete(key);
            this.validatedKeys.delete(key);
            this.validationMessages.delete(key);
            this.render();
          }
          return;
        }
        if (raw === MASKED_SENTINEL) return;
        if (this.buffered) {
          this.pendingSecrets.set(key, raw);
          const result = validateSecret(key, raw);
          if (result.valid) {
            this.validatedKeys.delete(key);
            this.validationMessages.delete(key);
          } else {
            this.validatedKeys.set(key, false);
            this.validationMessages.set(key, result.hint || 'Invalid format');
          }
          if (PLAINTEXT_KEYS.has(key)) {
            input.value = raw;
          } else {
            input.type = 'password';
            input.value = MASKED_SENTINEL;
          }
          input.placeholder = t('modals.runtimeConfig.placeholder.staged');
          const row = input.closest('.runtime-secret-row');
          const check = row?.querySelector('.runtime-secret-check');
          input.classList.remove('valid-staged', 'invalid');
          if (result.valid) {
            check?.classList.remove('visible');
            input.classList.add('valid-staged');
          } else {
            check?.classList.remove('visible');
            input.classList.add('invalid');
            const existingHint = row?.querySelector('.runtime-secret-hint');
            if (existingHint) existingHint.remove();
            if (result.hint) {
              const hint = document.createElement('span');
              hint.className = 'runtime-secret-hint';
              hint.textContent = result.hint;
              row?.appendChild(hint);
            }
          }
          this.updateFeatureCardStatus(key);

          // Update inline status text to reflect staged state
          const statusEl = input.closest('.runtime-secret-row')?.querySelector('.runtime-secret-status');
          if (statusEl) {
            statusEl.textContent = result.valid ? t('modals.runtimeConfig.status.staged') : t('modals.runtimeConfig.status.invalid');
            statusEl.className = `runtime-secret-status ${result.valid ? 'staged' : 'warn'}`;
          }

          // When Ollama URL is staged, auto-fetch available models
          if (key === 'OLLAMA_API_URL' && result.valid) {
            const modelSelect = this.content.querySelector<HTMLSelectElement>('select[data-model-select]');
            if (modelSelect) void this.fetchOllamaModels(modelSelect);
          }
        } else {
          void setSecretValue(key, raw);
          input.value = '';
        }
      });
    });
  }

  private updateFeatureCardStatus(secretKey: RuntimeSecretKey): void {
    const feature = RUNTIME_FEATURES.find(f => getEffectiveSecrets(f).includes(secretKey));
    if (!feature) return;
    const section = Array.from(this.content.querySelectorAll('.runtime-feature')).find(el => {
      const toggle = el.querySelector<HTMLInputElement>(`input[data-toggle="${feature.id}"]`);
      return !!toggle;
    });
    if (!section) return;
    const available = isFeatureAvailable(feature.id);
    const effectiveSecrets = getEffectiveSecrets(feature);
    const allStaged = !available && effectiveSecrets.every(
      (k) => getSecretState(k).valid || (this.pendingSecrets.has(k) && this.validatedKeys.get(k) !== false)
    );
    section.className = `runtime-feature ${available ? 'available' : allStaged ? 'staged' : 'degraded'}`;
    const pill = section.querySelector('.runtime-pill');
    if (pill) {
      pill.className = `runtime-pill ${available ? 'ok' : allStaged ? 'staged' : 'warn'}`;
      pill.textContent = available ? t('modals.runtimeConfig.status.ready') : allStaged ? t('modals.runtimeConfig.status.staged') : t('modals.runtimeConfig.status.needsKeys');
    }
    const fallback = section.querySelector('.runtime-feature-fallback');
    if (available || allStaged) {
      fallback?.remove();
    }
  }

  private static makeTimeout(ms: number): AbortSignal {
    if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), ms);
    return ctrl.signal;
  }

  private showManualModelInput(select: HTMLSelectElement): void {
    const manual = select.parentElement?.querySelector<HTMLInputElement>('input[data-model-manual]');
    if (!manual) return;
    select.style.display = 'none';
    manual.classList.remove('hidden-input');
    manual.addEventListener('blur', () => {
      const model = manual.value.trim();
      if (model && this.buffered) {
        this.pendingSecrets.set('OLLAMA_MODEL', model);
        this.validatedKeys.set('OLLAMA_MODEL', true);
        manual.classList.remove('invalid');
        manual.classList.add('valid-staged');
        this.updateFeatureCardStatus('OLLAMA_MODEL');
      }
    });
  }

  private async fetchOllamaModels(select: HTMLSelectElement): Promise<void> {
    const snapshot = getRuntimeConfigSnapshot();
    const ollamaUrl = this.pendingSecrets.get('OLLAMA_API_URL')
      || snapshot.secrets['OLLAMA_API_URL']?.value
      || '';
    if (!ollamaUrl) {
      select.innerHTML = '<option value="" disabled selected>Set Ollama URL first</option>';
      return;
    }

    const currentModel = this.pendingSecrets.get('OLLAMA_MODEL')
      || snapshot.secrets['OLLAMA_MODEL']?.value
      || '';

    try {
      // Try Ollama-native /api/tags first, fall back to OpenAI-compatible /v1/models
      let models: string[] = [];
      try {
        const res = await fetch(new URL('/api/tags', ollamaUrl).toString(), {
          signal: RuntimeConfigPanel.makeTimeout(5000),
        });
        if (res.ok) {
          const data = await res.json() as { models?: Array<{ name: string }> };
          models = (data.models?.map(m => m.name) || []).filter(n => !n.includes('embed'));
        }
      } catch { /* Ollama endpoint not available, try OpenAI format */ }

      if (models.length === 0) {
        try {
          const res = await fetch(new URL('/v1/models', ollamaUrl).toString(), {
            signal: RuntimeConfigPanel.makeTimeout(5000),
          });
          if (res.ok) {
            const data = await res.json() as { data?: Array<{ id: string }> };
            models = (data.data?.map(m => m.id) || []).filter(n => !n.includes('embed'));
          }
        } catch { /* OpenAI endpoint also unavailable */ }
      }

      if (models.length === 0) {
        // No models discovered — show manual text input as fallback
        this.showManualModelInput(select);
        return;
      }

      select.innerHTML = models.map(name =>
        `<option value="${escapeHtml(name)}" ${name === currentModel ? 'selected' : ''}>${escapeHtml(name)}</option>`
      ).join('');

      // Auto-select first model if none stored
      if (!currentModel && models.length > 0) {
        const first = models[0]!;
        select.value = first;
        if (this.buffered) {
          this.pendingSecrets.set('OLLAMA_MODEL', first);
          this.validatedKeys.set('OLLAMA_MODEL', true);
          select.classList.add('valid-staged');
          this.updateFeatureCardStatus('OLLAMA_MODEL');
        }
      }
    } catch {
      // Complete failure — fall back to manual input
      this.showManualModelInput(select);
    }
  }
}
