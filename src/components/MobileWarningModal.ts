import { t } from '@/services/i18n';
import { isMobileDevice } from '@/utils';
import { getDismissed, setDismissed } from '@/utils/cross-domain-storage';

const STORAGE_KEY = 'mobile-warning-dismissed';

export class MobileWarningModal {
  private element: HTMLElement;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'mobile-warning-overlay';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.innerHTML = `
      <div class="mobile-warning-modal">
        <div class="mobile-warning-header">
          <span class="mobile-warning-icon">📱</span>
          <span class="mobile-warning-title">${t('modals.mobileWarning.title')}</span>
        </div>
        <div class="mobile-warning-content">
          <p>${t('modals.mobileWarning.description')}</p>
          <p>${t('modals.mobileWarning.tip')}</p>
        </div>
        <div class="mobile-warning-footer">
          <label class="mobile-warning-remember">
            <input type="checkbox" id="mobileWarningRemember">
            <span>${t('modals.mobileWarning.dontShowAgain')}</span>
          </label>
          <button class="mobile-warning-btn">${t('modals.mobileWarning.gotIt')}</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.element);
    this.setupEventListeners();

    // Remove will-change after entrance animation to free GPU memory
    const modal = this.element.querySelector('.mobile-warning-modal') as HTMLElement | null;
    modal?.addEventListener('animationend', () => {
      modal.style.willChange = 'auto';
    }, { once: true });
  }

  private setupEventListeners(): void {
    this.element.querySelector('.mobile-warning-btn')?.addEventListener('click', () => {
      this.dismiss();
    });

    this.element.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('mobile-warning-overlay')) {
        this.dismiss();
      }
    });
  }

  private dismiss(): void {
    const checkbox = this.element.querySelector('#mobileWarningRemember') as HTMLInputElement;
    if (checkbox?.checked) {
      setDismissed(STORAGE_KEY);
    }
    this.hide();
  }

  public show(): void {
    this.element.classList.add('active');
  }

  public hide(): void {
    this.element.classList.remove('active');
  }

  public static shouldShow(): boolean {
    if (getDismissed(STORAGE_KEY)) return false;
    return isMobileDevice();
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
