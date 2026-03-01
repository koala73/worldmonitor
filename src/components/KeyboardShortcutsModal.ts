import { t } from '@/services/i18n';

interface ShortcutItem {
  key: string;
  description: string;
  modifier?: string;
}

const SHORTCUTS: ShortcutItem[] = [
  { key: '?', description: 'Show keyboard shortcuts' },
  { key: 'k', modifier: 'Ctrl/Cmd', description: 'Open search' },
  { key: 'f', modifier: 'Shift', description: 'Toggle fullscreen' },
  { key: 't', modifier: 'Shift', description: 'Toggle TV mode' },
  { key: 'p', modifier: 'Shift', description: 'Toggle playback control' },
  { key: 'Escape', description: 'Close modal / Exit fullscreen' },
  { key: '↑/↓', description: 'Navigate search results' },
  { key: 'Enter', description: 'Select highlighted result' },
];

export class KeyboardShortcutsModal {
  private overlay: HTMLElement | null = null;

  public show(): void {
    if (this.overlay) return;
    this.createModal();
  }

  public close(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  public isOpen(): boolean {
    return this.overlay !== null;
  }

  private createModal(): void {
    const overlay = document.createElement('div');
    overlay.className = 'shortcuts-modal-overlay';
    overlay.innerHTML = `
      <div class="shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <div class="shortcuts-modal-header">
          <h2 id="shortcuts-title">${t('modals.shortcuts.title')}</h2>
          <button class="shortcuts-close-btn" aria-label="${t('common.close')}">×</button>
        </div>
        <div class="shortcuts-modal-content">
          ${SHORTCUTS.map(s => `
            <div class="shortcut-item">
              <div class="shortcut-keys">
                ${s.modifier ? `<span class="shortcut-modifier">${s.modifier}</span> + ` : ''}
                <kbd class="shortcut-key">${s.key}</kbd>
              </div>
              <span class="shortcut-desc">${s.description}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });

    // Close button
    overlay.querySelector('.shortcuts-close-btn')?.addEventListener('click', () => this.close());

    // Close on Escape
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.close();
        document.removeEventListener('keydown', keyHandler);
      }
    };
    document.addEventListener('keydown', keyHandler);

    document.body.appendChild(overlay);
    this.overlay = overlay;
  }
}
