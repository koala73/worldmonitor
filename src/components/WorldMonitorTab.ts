import { getSecretState, setSecretValue, type RuntimeSecretKey } from '@/services/runtime-config';
import { getRemoteApiBaseUrl } from '@/services/runtime';
import { t } from '@/services/i18n';

const WM_KEY: RuntimeSecretKey = 'WORLDMONITOR_API_KEY';

export class WorldMonitorTab {
  private el: HTMLElement;
  private keyInput!: HTMLInputElement;
  private emailInput!: HTMLInputElement;
  private regStatus!: HTMLElement;
  private keyBadge!: HTMLElement;
  private pendingKeyValue: string | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'wm-tab';
    this.render();
  }

  private render(): void {
    const state = getSecretState(WM_KEY);
    const statusText = state.present
      ? t('modals.settingsWindow.worldMonitor.apiKey.statusValid')
      : t('modals.settingsWindow.worldMonitor.apiKey.statusMissing');
    const statusClass = state.present ? 'ok' : 'warn';

    this.el.innerHTML = `
      <section class="wm-section">
        <h2 class="wm-section-title">${t('modals.settingsWindow.worldMonitor.apiKey.title')}</h2>
        <p class="wm-section-desc">${t('modals.settingsWindow.worldMonitor.apiKey.description')}</p>
        <div class="wm-key-row">
          <div class="wm-input-wrap">
            <input type="password" class="wm-input" data-wm-key-input
              placeholder="${t('modals.settingsWindow.worldMonitor.apiKey.placeholder')}" autocomplete="off" spellcheck="false" />
            <button type="button" class="wm-toggle-vis" data-wm-toggle title="Show/hide">&#x1f441;</button>
          </div>
          <span class="wm-badge ${statusClass}" data-wm-badge>${statusText}</span>
        </div>
      </section>
      <section class="wm-section">
        <h2 class="wm-section-title">${t('modals.settingsWindow.worldMonitor.register.title')}</h2>
        <p class="wm-section-desc">${t('modals.settingsWindow.worldMonitor.register.description')}</p>
        <div class="wm-register-row">
          <input type="email" class="wm-input wm-email" data-wm-email
            placeholder="${t('modals.settingsWindow.worldMonitor.register.emailPlaceholder')}" />
          <button type="button" class="wm-submit-btn" data-wm-register>${t('modals.settingsWindow.worldMonitor.register.submitBtn')}</button>
        </div>
        <p class="wm-reg-status" data-wm-reg-status></p>
      </section>
    `;

    this.keyInput = this.el.querySelector('[data-wm-key-input]')!;
    this.emailInput = this.el.querySelector('[data-wm-email]')!;
    this.regStatus = this.el.querySelector('[data-wm-reg-status]')!;
    this.keyBadge = this.el.querySelector('[data-wm-badge]')!;

    this.keyInput.addEventListener('input', () => {
      this.pendingKeyValue = this.keyInput.value;
    });

    this.el.querySelector('[data-wm-toggle]')!.addEventListener('click', () => {
      this.keyInput.type = this.keyInput.type === 'password' ? 'text' : 'password';
    });

    this.el.querySelector('[data-wm-register]')!.addEventListener('click', () => {
      void this.submitRegistration();
    });
  }

  private async submitRegistration(): Promise<void> {
    const email = this.emailInput.value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.regStatus.textContent = t('modals.settingsWindow.worldMonitor.register.error');
      this.regStatus.className = 'wm-reg-status error';
      return;
    }

    const btn = this.el.querySelector('[data-wm-register]') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = t('modals.settingsWindow.worldMonitor.register.submitting');

    try {
      const res = await fetch(`${getRemoteApiBaseUrl()}/api/register-interest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'desktop-settings' }),
      });
      const data = await res.json() as { status?: string; error?: string };
      if (data.status === 'already_registered') {
        this.regStatus.textContent = t('modals.settingsWindow.worldMonitor.register.alreadyRegistered');
        this.regStatus.className = 'wm-reg-status ok';
      } else if (data.status === 'registered') {
        this.regStatus.textContent = t('modals.settingsWindow.worldMonitor.register.success');
        this.regStatus.className = 'wm-reg-status ok';
      } else {
        this.regStatus.textContent = data.error || t('modals.settingsWindow.worldMonitor.register.error');
        this.regStatus.className = 'wm-reg-status error';
      }
    } catch {
      this.regStatus.textContent = t('modals.settingsWindow.worldMonitor.register.error');
      this.regStatus.className = 'wm-reg-status error';
    } finally {
      btn.disabled = false;
      btn.textContent = t('modals.settingsWindow.worldMonitor.register.submitBtn');
    }
  }

  hasPendingChanges(): boolean {
    return this.pendingKeyValue !== null && this.pendingKeyValue.length > 0;
  }

  async save(): Promise<void> {
    if (this.pendingKeyValue === null) return;
    await setSecretValue(WM_KEY, this.pendingKeyValue);
    this.pendingKeyValue = null;
    const state = getSecretState(WM_KEY);
    this.keyBadge.textContent = state.present
      ? t('modals.settingsWindow.worldMonitor.apiKey.statusValid')
      : t('modals.settingsWindow.worldMonitor.apiKey.statusMissing');
    this.keyBadge.className = `wm-badge ${state.present ? 'ok' : 'warn'}`;
  }

  getElement(): HTMLElement {
    return this.el;
  }

  destroy(): void {
    this.el.innerHTML = '';
  }
}
