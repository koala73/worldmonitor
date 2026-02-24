/**
 * AI Flow Settings Popup — gear icon + dropdown for controlling AI analysis pipeline.
 * Web-only (hidden on Tauri desktop where settings window handles AI config).
 */

import { getAiFlowSettings, setAiFlowSetting, type AiFlowSettings } from '@/services/ai-flow-settings';
import { t } from '@/services/i18n';

const GEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

const DESKTOP_RELEASES_URL = 'https://github.com/koala73/worldmonitor/releases';

export class AiFlowPopup {
  public readonly wrapper: HTMLElement;
  private popup: HTMLElement;
  private cloudToggle: HTMLInputElement;
  private browserToggle: HTMLInputElement;
  private browserWarn: HTMLElement;
  private statusDot: HTMLElement;
  private statusText: HTMLElement;
  private outsideClickHandler: (e: MouseEvent) => void;
  private escapeHandler: (e: KeyboardEvent) => void;

  constructor() {
    // Wrapper (relative positioning anchor)
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'ai-flow-popup-wrapper';

    // Gear button
    const gearBtn = document.createElement('button');
    gearBtn.className = 'ai-flow-gear-btn';
    gearBtn.setAttribute('aria-label', t('components.insights.aiFlowTitle'));
    gearBtn.innerHTML = GEAR_SVG;
    gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    this.wrapper.appendChild(gearBtn);

    // Popup dialog
    this.popup = document.createElement('div');
    this.popup.className = 'ai-flow-popup';
    this.popup.setAttribute('role', 'dialog');
    this.popup.addEventListener('click', (e) => e.stopPropagation());

    const settings = getAiFlowSettings();

    // Header
    const header = document.createElement('div');
    header.className = 'ai-flow-popup-header';
    header.innerHTML = `<span>${t('components.insights.aiFlowTitle')}</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ai-flow-popup-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    this.popup.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'ai-flow-popup-body';

    // Toggle 1: Cloud AI
    const cloudRow = this.createToggleRow(
      'cloud',
      t('components.insights.aiFlowCloudLabel'),
      t('components.insights.aiFlowCloudDesc'),
      settings.cloudLlm,
    );
    this.cloudToggle = cloudRow.input;
    body.appendChild(cloudRow.row);

    // Toggle 2: Browser Local Model
    const browserRow = this.createToggleRow(
      'browser',
      t('components.insights.aiFlowBrowserLabel'),
      t('components.insights.aiFlowBrowserDesc'),
      settings.browserModel,
    );
    this.browserToggle = browserRow.input;

    // 250MB warning
    this.browserWarn = document.createElement('div');
    this.browserWarn.className = 'ai-flow-toggle-warn';
    this.browserWarn.textContent = t('components.insights.aiFlowBrowserWarn');
    this.browserWarn.style.display = settings.browserModel ? 'block' : 'none';
    browserRow.row.appendChild(this.browserWarn);

    body.appendChild(browserRow.row);

    // Ollama CTA
    const cta = document.createElement('div');
    cta.className = 'ai-flow-cta';
    cta.innerHTML = `<div class="ai-flow-cta-title">${t('components.insights.aiFlowOllamaCta')}</div>` +
      `<div class="ai-flow-cta-desc">${t('components.insights.aiFlowOllamaCtaDesc')}</div>` +
      `<a href="${DESKTOP_RELEASES_URL}" target="_blank" rel="noopener noreferrer" class="ai-flow-cta-link">${t('components.insights.aiFlowDownloadDesktop')}</a>`;
    body.appendChild(cta);

    this.popup.appendChild(body);

    // Footer — status
    const footer = document.createElement('div');
    footer.className = 'ai-flow-popup-footer';
    this.statusDot = document.createElement('span');
    this.statusDot.className = 'ai-flow-status-dot';
    this.statusText = document.createElement('span');
    this.statusText.className = 'ai-flow-status-text';
    footer.appendChild(this.statusDot);
    footer.appendChild(this.statusText);
    this.popup.appendChild(footer);

    this.wrapper.appendChild(this.popup);

    // Update status
    this.updateStatus(settings);

    // Toggle change handlers
    this.cloudToggle.addEventListener('change', () => {
      setAiFlowSetting('cloudLlm', this.cloudToggle.checked);
      this.syncUI();
    });
    this.browserToggle.addEventListener('change', () => {
      setAiFlowSetting('browserModel', this.browserToggle.checked);
      this.syncUI();
    });

    // Outside click
    this.outsideClickHandler = (e: MouseEvent) => {
      if (!this.wrapper.contains(e.target as Node)) {
        this.close();
      }
    };
    document.addEventListener('click', this.outsideClickHandler);

    // Escape key
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', this.escapeHandler);
  }

  private createToggleRow(
    id: string,
    label: string,
    description: string,
    checked: boolean,
  ): { row: HTMLElement; input: HTMLInputElement } {
    const row = document.createElement('div');
    row.className = 'ai-flow-toggle-row';

    const labelWrap = document.createElement('div');
    labelWrap.className = 'ai-flow-toggle-label-wrap';
    labelWrap.innerHTML = `<div class="ai-flow-toggle-label">${label}</div>` +
      `<div class="ai-flow-toggle-desc">${description}</div>`;

    const switchLabel = document.createElement('label');
    switchLabel.className = 'ai-flow-switch';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.id = `ai-flow-${id}`;

    const slider = document.createElement('span');
    slider.className = 'ai-flow-slider';

    switchLabel.appendChild(input);
    switchLabel.appendChild(slider);

    row.appendChild(labelWrap);
    row.appendChild(switchLabel);

    return { row, input };
  }

  private syncUI(): void {
    const settings = getAiFlowSettings();
    this.browserWarn.style.display = settings.browserModel ? 'block' : 'none';
    this.updateStatus(settings);
  }

  private updateStatus(settings: AiFlowSettings): void {
    this.statusDot.className = 'ai-flow-status-dot';

    if (settings.cloudLlm && settings.browserModel) {
      this.statusDot.classList.add('active');
      this.statusText.textContent = t('components.insights.aiFlowStatusCloudAndBrowser');
    } else if (settings.cloudLlm) {
      this.statusDot.classList.add('active');
      this.statusText.textContent = t('components.insights.aiFlowStatusActive');
    } else if (settings.browserModel) {
      this.statusDot.classList.add('browser-only');
      this.statusText.textContent = t('components.insights.aiFlowStatusBrowserOnly');
    } else {
      this.statusDot.classList.add('disabled');
      this.statusText.textContent = t('components.insights.aiFlowStatusDisabled');
    }
  }

  private toggle(): void {
    this.popup.classList.toggle('visible');
  }

  private close(): void {
    this.popup.classList.remove('visible');
  }

  public destroy(): void {
    document.removeEventListener('click', this.outsideClickHandler);
    document.removeEventListener('keydown', this.escapeHandler);
    this.wrapper.remove();
  }
}
