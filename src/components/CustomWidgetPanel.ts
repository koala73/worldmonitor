import { Panel } from './Panel';
import type { CustomWidgetSpec } from '@/services/widget-store';
import { saveWidget } from '@/services/widget-store';
import { t } from '@/services/i18n';
import { wrapWidgetHtml, wrapProWidgetHtml } from '@/utils/widget-sanitizer';
import { h } from '@/utils/dom-utils';

const ACCENT_COLORS: Array<string | null> = [
  '#44ff88', '#ff8844', '#4488ff', '#ff44ff',
  '#ffff44', '#ff4444', '#44ffff', '#3b82f6',
  null,
];

export class CustomWidgetPanel extends Panel {
  private spec: CustomWidgetSpec;

  constructor(spec: CustomWidgetSpec) {
    super({
      id: spec.id,
      title: spec.title,
      closable: true,
      className: 'custom-widget-panel',
    });
    this.spec = spec;
    this.addHeaderButtons();
    this.renderWidget();
  }

  private addHeaderButtons(): void {
    const closeBtn = this.header.querySelector('.panel-close-btn');

    const colorBtn = h('button', {
      className: 'icon-btn widget-color-btn widget-header-btn',
      title: t('widgets.changeAccent'),
      'aria-label': t('widgets.changeAccent'),
    });
    colorBtn.style.setProperty('background', this.spec.accentColor ?? 'var(--accent)');
    colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cycleAccentColor(colorBtn);
    });

    const chatBtn = h('button', {
      className: 'icon-btn panel-widget-chat-btn widget-header-btn',
      title: t('widgets.modifyWithAi'),
      'aria-label': t('widgets.modifyWithAi'),
    }, '\u2726');
    chatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.element.dispatchEvent(new CustomEvent('wm:widget-modify', {
        bubbles: true,
        detail: { widgetId: this.spec.id },
      }));
    });

    if (this.spec.tier === 'pro') {
      const badge = h('span', { className: 'widget-pro-badge' }, t('widgets.proBadge'));
      if (closeBtn) {
        this.header.insertBefore(badge, closeBtn);
      } else {
        this.header.appendChild(badge);
      }
    }

    if (closeBtn) {
      this.header.insertBefore(colorBtn, closeBtn);
      this.header.insertBefore(chatBtn, closeBtn);
    } else {
      this.header.appendChild(colorBtn);
      this.header.appendChild(chatBtn);
    }
  }

  private cycleAccentColor(btn: HTMLElement): void {
    const current = this.spec.accentColor;
    const idx = ACCENT_COLORS.indexOf(current);
    const next = ACCENT_COLORS[(idx + 1) % ACCENT_COLORS.length] ?? null;
    this.spec = { ...this.spec, accentColor: next, updatedAt: Date.now() };
    saveWidget(this.spec);
    btn.style.setProperty('background', next ?? 'var(--accent)');
    this.applyAccentColor();
  }

  renderWidget(): void {
    if (this.spec.tier === 'pro') {
      this.setContent(wrapProWidgetHtml(this.spec.html));
    } else {
      this.setContent(wrapWidgetHtml(this.spec.html));
    }
    this.applyAccentColor();
  }

  private applyAccentColor(): void {
    if (this.spec.accentColor) {
      this.element.style.setProperty('--widget-accent', this.spec.accentColor);
    } else {
      this.element.style.removeProperty('--widget-accent');
    }
  }

  updateSpec(spec: CustomWidgetSpec): void {
    this.spec = spec;
    const titleEl = this.header.querySelector('.panel-title');
    if (titleEl) titleEl.textContent = spec.title;
    this.renderWidget();
    const colorBtn = this.header.querySelector('.widget-color-btn') as HTMLElement | null;
    if (colorBtn) colorBtn.style.setProperty('background', spec.accentColor ?? 'var(--accent)');
  }

  getSpec(): CustomWidgetSpec {
    return this.spec;
  }
}
