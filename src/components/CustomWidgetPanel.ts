import { Panel } from './Panel';
import type { CustomWidgetSpec } from '@/services/widget-store';
import { t } from '@/services/i18n';
import { wrapWidgetHtml, wrapProWidgetHtml } from '@/utils/widget-sanitizer';
import { h } from '@/utils/dom-utils';

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
      this.header.insertBefore(chatBtn, closeBtn);
    } else {
      this.header.appendChild(chatBtn);
    }
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
  }

  getSpec(): CustomWidgetSpec {
    return this.spec;
  }
}
