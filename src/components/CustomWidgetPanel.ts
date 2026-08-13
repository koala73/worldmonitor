import { Panel } from './Panel';
import type { CustomWidgetSpec } from '@/services/widget-store';
import { t } from '@/services/i18n';
import { wrapWidgetHtml, wrapProWidgetHtml } from '@/utils/widget-sanitizer';
import { h } from '@/utils/dom-utils';
import { unsafeRawHtml } from '@/utils/sanitize';

// Keep the palette deliberately small and named in code instead of accepting an
// arbitrary CSS value from a click event. Widget HTML is agent-produced, so
// panel chrome must not become another style-injection surface.
const WIDGET_ACCENT_COLORS = ['#38bdf8', '#a78bfa', '#f59e0b', '#34d399', '#fb7185'] as const;
// Custom widgets mount only after hydration from user-owned storage. Keep this
// deferred control's copy in the full locale rather than the 50 KiB first-paint
// shell resource used by static dashboard chrome.
const WIDGET_ACCENT_TRANSLATION_KEY = 'widgets.changeAccent';

export class CustomWidgetPanel extends Panel {
  private spec: CustomWidgetSpec;

  constructor(spec: CustomWidgetSpec) {
    super({
      id: spec.id,
      title: spec.title,
      closable: true,
      className: 'custom-widget-panel',
      defaultRowSpan: 2,
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

    const colorBtn = h('button', {
      className: 'icon-btn widget-color-btn widget-header-btn',
      title: t(WIDGET_ACCENT_TRANSLATION_KEY),
      'aria-label': t(WIDGET_ACCENT_TRANSLATION_KEY),
      style: `background:${this.currentAccentColor()}`,
    });
    colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.element.dispatchEvent(new CustomEvent('wm:widget-accent-change', {
        bubbles: true,
        detail: { widgetId: this.spec.id, accentColor: this.nextAccentColor() },
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
      this.header.insertBefore(colorBtn, closeBtn);
    } else {
      this.header.appendChild(chatBtn);
      this.header.appendChild(colorBtn);
    }
  }

  private currentAccentColor(): string {
    return this.spec.accentColor ?? WIDGET_ACCENT_COLORS[0]!;
  }

  private nextAccentColor(): string {
    const currentIndex = this.spec.accentColor
      ? WIDGET_ACCENT_COLORS.indexOf(this.spec.accentColor as typeof WIDGET_ACCENT_COLORS[number])
      : -1;
    // An unset accent is displayed with the first palette color. The next
    // selection must therefore be the *second* color; otherwise the first
    // click is visually and persistently a no-op.
    const nextIndex = currentIndex < 0 ? 1 : (currentIndex + 1) % WIDGET_ACCENT_COLORS.length;
    return WIDGET_ACCENT_COLORS[nextIndex]!;
  }

  renderWidget(): void {
    if (this.spec.tier === 'pro') {
      this.setSafeContent(unsafeRawHtml(wrapProWidgetHtml(this.spec.html), 'legacy Panel.setContent() migration'));
    } else {
      this.setSafeContent(unsafeRawHtml(wrapWidgetHtml(this.spec.html), 'legacy Panel.setContent() migration'));
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
    const colorButton = this.header.querySelector<HTMLButtonElement>('.widget-color-btn');
    if (colorButton) colorButton.style.background = this.currentAccentColor();
    this.renderWidget();
  }

  getSpec(): CustomWidgetSpec {
    return this.spec;
  }
}
