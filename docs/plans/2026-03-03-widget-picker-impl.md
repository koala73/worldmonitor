# Widget Picker & Layout Presets Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the Settings > Panels tab with a "+" widget picker popover in the header, add "x" close buttons to panels, and introduce layout preset tabs for quick switching between curated panel configurations.

**Architecture:** New `src/config/layouts.ts` defines curated layout presets per variant. A `WidgetPicker` class renders the "+" popover with categorized toggle list. A `LayoutTabs` class renders layout preset tabs in the header. The Panel base class gets an "x" close button. The UnifiedSettings Panels tab is removed.

**Tech Stack:** Vanilla TypeScript, CSS, DOM API (`h()` helper from `src/utils/dom-utils.ts`), localStorage persistence.

---

### Task 1: Create Layout Presets Config

**Files:**
- Create: `src/config/layouts.ts`

**Step 1: Create the layout presets file**

```typescript
import { SITE_VARIANT } from './variant';

export interface LayoutPreset {
  id: string;
  labelKey: string;
  icon: string;
  panelKeys: string[];
}

const FULL_LAYOUTS: LayoutPreset[] = [
  {
    id: 'intelligence-analyst',
    labelKey: 'layouts.intelligenceAnalyst',
    icon: '🔍',
    panelKeys: [
      'map', 'live-news', 'insights', 'strategic-posture', 'cii',
      'strategic-risk', 'intel', 'gdelt-intel', 'cascade', 'telegram-intel',
      'monitors', 'satellite-fires', 'displacement', 'oref-sirens',
    ],
  },
  {
    id: 'market-watch',
    labelKey: 'layouts.marketWatch',
    icon: '📈',
    panelKeys: [
      'map', 'live-news', 'insights', 'markets', 'commodities', 'crypto',
      'economic', 'macro-signals', 'etf-flows', 'stablecoins',
      'gulf-economies', 'heatmap', 'polymarket', 'finance',
    ],
  },
  {
    id: 'breaking-news',
    labelKey: 'layouts.breakingNews',
    icon: '📰',
    panelKeys: [
      'map', 'live-news', 'live-webcams', 'insights', 'politics', 'us',
      'europe', 'middleeast', 'africa', 'latam', 'asia',
    ],
  },
  {
    id: 'minimal',
    labelKey: 'layouts.minimal',
    icon: '◯',
    panelKeys: ['map', 'live-news', 'insights', 'strategic-posture'],
  },
];

const TECH_LAYOUTS: LayoutPreset[] = [
  {
    id: 'tech-overview',
    labelKey: 'layouts.techOverview',
    icon: '💻',
    panelKeys: [
      'map', 'live-news', 'insights', 'ai', 'tech', 'hardware', 'cloud',
      'dev', 'github', 'producthunt', 'service-status', 'tech-readiness',
    ],
  },
  {
    id: 'startup-investor',
    labelKey: 'layouts.startupInvestor',
    icon: '🚀',
    panelKeys: [
      'map', 'live-news', 'insights', 'startups', 'vcblogs', 'unicorns',
      'accelerators', 'funding', 'ipo', 'regionalStartups',
    ],
  },
  {
    id: 'tech-minimal',
    labelKey: 'layouts.minimal',
    icon: '◯',
    panelKeys: ['map', 'live-news', 'insights', 'ai', 'tech'],
  },
];

const FINANCE_LAYOUTS: LayoutPreset[] = [
  {
    id: 'full-markets',
    labelKey: 'layouts.fullMarkets',
    icon: '📊',
    panelKeys: [
      'map', 'live-news', 'insights', 'markets', 'markets-news', 'forex',
      'bonds', 'commodities', 'crypto', 'centralbanks', 'economic',
      'heatmap', 'macro-signals',
    ],
  },
  {
    id: 'crypto-focus',
    labelKey: 'layouts.cryptoFocus',
    icon: '₿',
    panelKeys: [
      'map', 'live-news', 'insights', 'crypto', 'crypto-news', 'etf-flows',
      'stablecoins', 'fintech', 'markets', 'macro-signals',
    ],
  },
  {
    id: 'finance-minimal',
    labelKey: 'layouts.minimal',
    icon: '◯',
    panelKeys: ['map', 'live-news', 'insights', 'markets', 'economic'],
  },
];

const HAPPY_LAYOUTS: LayoutPreset[] = [
  {
    id: 'happy-all',
    labelKey: 'layouts.allGoodNews',
    icon: '☀️',
    panelKeys: [
      'map', 'positive-feed', 'progress', 'counters', 'spotlight',
      'breakthroughs', 'digest', 'species', 'renewable', 'giving',
    ],
  },
  {
    id: 'happy-minimal',
    labelKey: 'layouts.minimal',
    icon: '◯',
    panelKeys: ['map', 'positive-feed', 'digest', 'progress'],
  },
];

export const LAYOUT_PRESETS: LayoutPreset[] =
  SITE_VARIANT === 'happy' ? HAPPY_LAYOUTS
  : SITE_VARIANT === 'tech' ? TECH_LAYOUTS
  : SITE_VARIANT === 'finance' ? FINANCE_LAYOUTS
  : FULL_LAYOUTS;

export const LAYOUT_STORAGE_KEY = 'worldmonitor-active-layout';
export const LAYOUT_OVERRIDES_PREFIX = 'worldmonitor-layout-overrides-';
```

**Step 2: Run type check**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to layouts.ts

**Step 3: Commit**

```bash
git add src/config/layouts.ts
git commit -m "feat: add layout presets config (#882)"
```

---

### Task 2: Add i18n Keys for Layouts

**Files:**
- Modify: `src/locales/en.json`

**Step 1: Add layout label keys to en.json**

Add a `"layouts"` section to `en.json`:

```json
"layouts": {
  "intelligenceAnalyst": "Intelligence",
  "marketWatch": "Markets",
  "breakingNews": "News",
  "minimal": "Minimal",
  "techOverview": "Tech Overview",
  "startupInvestor": "Startups",
  "fullMarkets": "Full Markets",
  "cryptoFocus": "Crypto",
  "allGoodNews": "All Good News",
  "addWidget": "Add Widget",
  "filterWidgets": "Filter...",
  "modified": "modified",
  "clickToReset": "Click to reset"
}
```

**Step 2: Commit**

```bash
git add src/locales/en.json
git commit -m "feat: add i18n keys for layout presets (#882)"
```

---

### Task 3: Build the LayoutTabs Component

**Files:**
- Create: `src/components/LayoutTabs.ts`
- Modify: `src/styles/main.css` (add layout tab styles)

**Step 1: Create LayoutTabs.ts**

```typescript
import { LAYOUT_PRESETS, LAYOUT_STORAGE_KEY, LAYOUT_OVERRIDES_PREFIX } from '@/config/layouts';
import type { LayoutPreset } from '@/config/layouts';
import type { PanelConfig } from '@/types';
import { t } from '@/locales';

export interface LayoutTabsCallbacks {
  getPanelSettings: () => Record<string, PanelConfig>;
  applyLayout: (panelKeys: string[]) => void;
}

export class LayoutTabs {
  private container: HTMLElement;
  private activeLayoutId: string;
  private modified = false;
  private callbacks: LayoutTabsCallbacks;

  constructor(callbacks: LayoutTabsCallbacks) {
    this.callbacks = callbacks;
    this.activeLayoutId = localStorage.getItem(LAYOUT_STORAGE_KEY) || LAYOUT_PRESETS[0]?.id || '';
    this.container = document.createElement('div');
    this.container.className = 'layout-tabs';
    this.render();
  }

  getElement(): HTMLElement {
    return this.container;
  }

  getActiveLayoutId(): string {
    return this.activeLayoutId;
  }

  /** Check if user has modified the active layout's panel set. */
  checkModified(): void {
    const preset = LAYOUT_PRESETS.find(l => l.id === this.activeLayoutId);
    if (!preset) { this.setModified(false); return; }
    const settings = this.callbacks.getPanelSettings();
    const enabledKeys = new Set(
      Object.entries(settings)
        .filter(([, c]) => c.enabled)
        .map(([k]) => k),
    );
    const presetKeys = new Set(preset.panelKeys);
    const same = enabledKeys.size === presetKeys.size && [...enabledKeys].every(k => presetKeys.has(k));
    this.setModified(!same);
  }

  private setModified(mod: boolean): void {
    if (this.modified === mod) return;
    this.modified = mod;
    const activeTab = this.container.querySelector('.layout-tab.active');
    activeTab?.classList.toggle('modified', mod);
  }

  private render(): void {
    this.container.innerHTML = '';
    for (const preset of LAYOUT_PRESETS) {
      const tab = document.createElement('button');
      tab.className = `layout-tab${preset.id === this.activeLayoutId ? ' active' : ''}`;
      tab.dataset.layoutId = preset.id;
      tab.title = preset.id === this.activeLayoutId && this.modified
        ? t('layouts.clickToReset')
        : t(preset.labelKey);
      tab.innerHTML = `<span class="layout-tab-icon">${preset.icon}</span><span class="layout-tab-label">${t(preset.labelKey)}</span>`;
      tab.addEventListener('click', () => this.onTabClick(preset));
      this.container.appendChild(tab);
    }
  }

  private onTabClick(preset: LayoutPreset): void {
    if (preset.id === this.activeLayoutId && this.modified) {
      // Reset to defaults — clear overrides
      localStorage.removeItem(LAYOUT_OVERRIDES_PREFIX + preset.id);
      this.callbacks.applyLayout(preset.panelKeys);
      this.setModified(false);
      return;
    }
    if (preset.id === this.activeLayoutId) return;

    this.activeLayoutId = preset.id;
    localStorage.setItem(LAYOUT_STORAGE_KEY, preset.id);

    // Check for saved overrides
    const overridesJson = localStorage.getItem(LAYOUT_OVERRIDES_PREFIX + preset.id);
    if (overridesJson) {
      try {
        const overrideKeys: string[] = JSON.parse(overridesJson);
        this.callbacks.applyLayout(overrideKeys);
        this.setModified(true);
      } catch {
        this.callbacks.applyLayout(preset.panelKeys);
        this.setModified(false);
      }
    } else {
      this.callbacks.applyLayout(preset.panelKeys);
      this.setModified(false);
    }

    // Update active tab styling
    this.container.querySelectorAll('.layout-tab').forEach(el => {
      el.classList.toggle('active', (el as HTMLElement).dataset.layoutId === preset.id);
      el.classList.remove('modified');
    });
  }
}
```

**Step 2: Add CSS for layout tabs**

Add to `src/styles/main.css` after the `.header-right` styles:

```css
/* Layout tabs */
.layout-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  margin: 0 12px;
  flex-shrink: 1;
  overflow-x: auto;
}

.layout-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}

.layout-tab:hover {
  background: var(--overlay-subtle);
  color: var(--text);
}

.layout-tab.active {
  background: var(--overlay-subtle);
  border-color: var(--border);
  color: var(--text);
  font-weight: 600;
}

.layout-tab.modified::after {
  content: '•';
  margin-left: 2px;
  color: var(--accent, #4488ff);
  font-size: 14px;
  line-height: 1;
}

.layout-tab-icon {
  font-size: 12px;
}

.layout-tab-label {
  font-size: 10px;
}

@media (max-width: 900px) {
  .layout-tabs {
    display: none;
  }
}
```

**Step 3: Run type check**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

**Step 4: Commit**

```bash
git add src/components/LayoutTabs.ts src/styles/main.css
git commit -m "feat: add LayoutTabs component (#882)"
```

---

### Task 4: Build the WidgetPicker Popover Component

**Files:**
- Create: `src/components/WidgetPicker.ts`
- Modify: `src/styles/main.css` (add widget picker styles)

**Step 1: Create WidgetPicker.ts**

```typescript
import { PANEL_CATEGORY_MAP } from '@/config/panels';
import { SITE_VARIANT } from '@/config/variant';
import type { PanelConfig } from '@/types';
import { t } from '@/locales';

export interface WidgetPickerCallbacks {
  getPanelSettings: () => Record<string, PanelConfig>;
  togglePanel: (key: string) => void;
  getLocalizedPanelName: (key: string, fallback: string) => string;
}

export class WidgetPicker {
  private wrapper: HTMLElement;
  private dropdown: HTMLElement;
  private button: HTMLElement;
  private filterInput: HTMLInputElement | null = null;
  private callbacks: WidgetPickerCallbacks;
  private open = false;
  private outsideClickHandler: (e: MouseEvent) => void;
  private escHandler: (e: KeyboardEvent) => void;

  constructor(callbacks: WidgetPickerCallbacks) {
    this.callbacks = callbacks;

    this.wrapper = document.createElement('div');
    this.wrapper.className = 'widget-picker-wrapper';

    this.button = document.createElement('button');
    this.button.className = 'widget-picker-btn';
    this.button.title = t('layouts.addWidget');
    this.button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    this.dropdown = document.createElement('div');
    this.dropdown.className = 'widget-picker-dropdown';

    this.wrapper.appendChild(this.button);
    this.wrapper.appendChild(this.dropdown);

    this.outsideClickHandler = () => this.close();
    this.escHandler = (e) => { if (e.key === 'Escape') this.close(); };
  }

  getElement(): HTMLElement {
    return this.wrapper;
  }

  private toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  private show(): void {
    this.renderDropdown();
    this.dropdown.classList.add('open');
    this.open = true;
    setTimeout(() => {
      document.addEventListener('click', this.outsideClickHandler);
      document.addEventListener('keydown', this.escHandler);
    }, 0);
    this.filterInput?.focus();
  }

  close(): void {
    this.dropdown.classList.remove('open');
    this.open = false;
    document.removeEventListener('click', this.outsideClickHandler);
    document.removeEventListener('keydown', this.escHandler);
  }

  /** Re-render the toggle states (call after layout switch). */
  refresh(): void {
    if (this.open) this.renderDropdown();
  }

  private renderDropdown(): void {
    const settings = this.callbacks.getPanelSettings();
    const filter = this.filterInput?.value.toLowerCase() || '';

    this.dropdown.innerHTML = '';

    // Header with filter input
    const header = document.createElement('div');
    header.className = 'widget-picker-header';
    header.innerHTML = `<span class="widget-picker-title">${t('layouts.addWidget')}</span>`;
    this.filterInput = document.createElement('input');
    this.filterInput.type = 'text';
    this.filterInput.className = 'widget-picker-filter';
    this.filterInput.placeholder = t('layouts.filterWidgets');
    this.filterInput.value = filter;
    this.filterInput.addEventListener('input', () => this.renderDropdown());
    this.filterInput.addEventListener('click', (e) => e.stopPropagation());
    header.appendChild(this.filterInput);
    this.dropdown.appendChild(header);

    // Scrollable list
    const list = document.createElement('div');
    list.className = 'widget-picker-list';

    const variant = SITE_VARIANT || 'full';
    for (const [, cat] of Object.entries(PANEL_CATEGORY_MAP)) {
      if (cat.variants && !cat.variants.includes(variant)) continue;

      const matchingPanels = cat.panelKeys.filter(key => {
        if (!(key in settings)) return false;
        if (key === 'map') return false; // map is always visible
        if (!filter) return true;
        const name = this.callbacks.getLocalizedPanelName(key, settings[key]?.name || key);
        return name.toLowerCase().includes(filter);
      });

      if (matchingPanels.length === 0) continue;

      const catHeader = document.createElement('div');
      catHeader.className = 'widget-picker-cat';
      catHeader.textContent = t(cat.labelKey);
      list.appendChild(catHeader);

      for (const key of matchingPanels) {
        const config = settings[key];
        const item = document.createElement('div');
        item.className = `widget-picker-item${config.enabled ? ' active' : ''}`;
        item.dataset.panel = key;
        const name = this.callbacks.getLocalizedPanelName(key, config.name || key);
        item.innerHTML = `<span class="widget-picker-check">${config.enabled ? '✓' : ''}</span><span class="widget-picker-name">${name}</span>`;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.callbacks.togglePanel(key);
          // Re-render to update check marks
          this.renderDropdown();
        });
        list.appendChild(item);
      }
    }

    this.dropdown.appendChild(list);
  }
}
```

**Step 2: Add CSS for widget picker**

Add to `src/styles/main.css`:

```css
/* Widget picker */
.widget-picker-wrapper {
  position: relative;
  display: inline-flex;
}

.widget-picker-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
}

.widget-picker-btn:hover {
  background: var(--overlay-subtle);
  color: var(--text);
  border-color: var(--border-strong, var(--border));
}

.widget-picker-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  width: 280px;
  background: var(--overlay, var(--surface));
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px var(--shadow-color, rgba(0,0,0,0.3));
  z-index: 1100;
  display: none;
  margin-top: 4px;
}

.widget-picker-dropdown.open {
  display: block;
}

.widget-picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  gap: 8px;
}

.widget-picker-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text);
  white-space: nowrap;
}

.widget-picker-filter {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--surface);
  color: var(--text);
  font-size: 11px;
  outline: none;
}

.widget-picker-filter:focus {
  border-color: var(--accent, #4488ff);
}

.widget-picker-list {
  max-height: 400px;
  overflow-y: auto;
  padding: 4px 0;
}

.widget-picker-cat {
  padding: 6px 10px 2px;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-dim);
}

.widget-picker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  transition: background 0.1s;
}

.widget-picker-item:hover {
  background: var(--overlay-subtle);
}

.widget-picker-check {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 10px;
  color: var(--text-dim);
  flex-shrink: 0;
}

.widget-picker-item.active .widget-picker-check {
  background: var(--accent, #4488ff);
  border-color: var(--accent, #4488ff);
  color: #fff;
}

.widget-picker-name {
  font-size: 11px;
  color: var(--text);
}
```

**Step 3: Run type check**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

**Step 4: Commit**

```bash
git add src/components/WidgetPicker.ts src/styles/main.css
git commit -m "feat: add WidgetPicker popover component (#882)"
```

---

### Task 5: Add "x" Close Button to Panel Base Class

**Files:**
- Modify: `src/components/Panel.ts:198-291` (constructor)
- Modify: `src/styles/main.css` (add close button styles)

**Step 1: Add close button to Panel constructor**

In `src/components/Panel.ts`, after the count element is appended to `this.header` (after line 255), add the close button:

```typescript
// Close button (skip for map panel)
if (options.id !== 'map') {
  this.closeBtn = document.createElement('button');
  this.closeBtn.className = 'panel-close-btn';
  this.closeBtn.title = 'Remove';
  this.closeBtn.innerHTML = '×';
  this.closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    this.onClose?.(this.panelId);
  });
  this.header.appendChild(this.closeBtn);
}
```

Add the corresponding class properties near the top of the Panel class (near the other element declarations):

```typescript
private closeBtn?: HTMLElement;
public onClose?: (panelId: string) => void;
```

**Step 2: Add CSS for close button**

Add to `src/styles/main.css`:

```css
/* Panel close button */
.panel-close-btn {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: all 0.15s;
  margin-left: 4px;
  flex-shrink: 0;
}

.panel:hover .panel-close-btn {
  opacity: 1;
}

.panel-close-btn:hover {
  background: var(--overlay-subtle);
  color: var(--text);
}
```

**Step 3: Run type check**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

**Step 4: Commit**

```bash
git add src/components/Panel.ts src/styles/main.css
git commit -m "feat: add close button to panel headers (#882)"
```

---

### Task 6: Wire LayoutTabs and WidgetPicker into Header

**Files:**
- Modify: `src/app/panel-layout.ts:115-204` (renderLayout header HTML)
- Modify: `src/app/event-handlers.ts:552-602` (setupUnifiedSettings)

**Step 1: Add layout tabs mount point to header HTML**

In `src/app/panel-layout.ts` `renderLayout()`, insert a mount point between `.header-left` and `.header-right`. After the closing `</div>` of `.header-left` (line 184) and before `<div class="header-right">` (line 185), add:

```html
<div class="layout-tabs-mount" id="layoutTabsMount"></div>
```

**Step 2: Add widget picker mount point to header-right**

In the `.header-right` section, insert `<span id="widgetPickerMount"></span>` before the `<span id="unifiedSettingsMount"></span>` (line 202). So it appears right before the settings gear button.

**Step 3: Modify event-handlers.ts to instantiate and wire up components**

Add imports at the top of `src/app/event-handlers.ts`:

```typescript
import { LayoutTabs } from '@/components/LayoutTabs';
import { WidgetPicker } from '@/components/WidgetPicker';
import { LAYOUT_PRESETS, LAYOUT_STORAGE_KEY, LAYOUT_OVERRIDES_PREFIX } from '@/config/layouts';
import { STORAGE_KEYS } from '@/config/panels';
```

Add a new method `setupLayoutSystem()` in the EventHandlers class:

```typescript
setupLayoutSystem(): void {
  // Layout tabs
  this.ctx.layoutTabs = new LayoutTabs({
    getPanelSettings: () => this.ctx.panelSettings,
    applyLayout: (panelKeys: string[]) => {
      const keySet = new Set(panelKeys);
      for (const [key, config] of Object.entries(this.ctx.panelSettings)) {
        config.enabled = keySet.has(key);
      }
      saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
      this.applyPanelSettings();
      this.ctx.widgetPicker?.refresh();
    },
  });

  const tabsMount = document.getElementById('layoutTabsMount');
  if (tabsMount) tabsMount.appendChild(this.ctx.layoutTabs.getElement());

  // Widget picker
  this.ctx.widgetPicker = new WidgetPicker({
    getPanelSettings: () => this.ctx.panelSettings,
    togglePanel: (key: string) => {
      const config = this.ctx.panelSettings[key];
      if (config) {
        config.enabled = !config.enabled;
        trackPanelToggled(key, config.enabled);
        saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
        this.applyPanelSettings();
        // Save overrides and update layout tab modified state
        this.saveLayoutOverrides();
        this.ctx.layoutTabs?.checkModified();
      }
    },
    getLocalizedPanelName: (key: string, fallback: string) => this.getLocalizedPanelName(key, fallback),
  });

  const pickerMount = document.getElementById('widgetPickerMount');
  if (pickerMount) pickerMount.appendChild(this.ctx.widgetPicker.getElement());
}

private saveLayoutOverrides(): void {
  const activeId = this.ctx.layoutTabs?.getActiveLayoutId();
  if (!activeId) return;
  const enabledKeys = Object.entries(this.ctx.panelSettings)
    .filter(([, c]) => c.enabled)
    .map(([k]) => k);
  localStorage.setItem(LAYOUT_OVERRIDES_PREFIX + activeId, JSON.stringify(enabledKeys));
}
```

**Step 4: Wire panel close buttons**

In the existing `applyPanelSettings()` method (line 899), after `panel?.toggle(config.enabled)`, wire the close callback for each panel:

```typescript
if (panel && !panel.onClose) {
  panel.onClose = (panelId: string) => {
    const cfg = this.ctx.panelSettings[panelId];
    if (cfg) {
      cfg.enabled = false;
      trackPanelToggled(panelId, false);
      saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
      this.applyPanelSettings();
      this.saveLayoutOverrides();
      this.ctx.layoutTabs?.checkModified();
      this.ctx.widgetPicker?.refresh();
    }
  };
}
```

**Step 5: Call setupLayoutSystem() from the init flow**

In `src/app/event-handlers.ts`, find where `setupUnifiedSettings()` is called (it's called from the init chain). Add `this.setupLayoutSystem()` right before `setupUnifiedSettings()`.

**Step 6: Add layoutTabs and widgetPicker to the AppContext type**

Check `src/types` or wherever AppContext is defined and add:

```typescript
layoutTabs?: LayoutTabs;
widgetPicker?: WidgetPicker;
```

**Step 7: Run type check and dev server**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

Run: `npm run dev` and verify in browser:
- Layout tabs appear in header between left/right sections
- "+" button appears in header-right before settings
- Clicking "+" opens popover with categorized panel list
- Toggling panels works
- Clicking layout tabs switches panel sets
- "x" on panels removes them
- Modified indicator (dot) appears on active tab after changes

**Step 8: Commit**

```bash
git add src/app/panel-layout.ts src/app/event-handlers.ts
git commit -m "feat: wire LayoutTabs and WidgetPicker into header (#882)"
```

---

### Task 7: Remove Settings > Panels Tab

**Files:**
- Modify: `src/components/UnifiedSettings.ts:239,246-257` (remove panels tab)

**Step 1: Remove the Panels tab button**

In `UnifiedSettings.ts`, find the tab button for panels (line 239):
```html
<button class="${tabClass('panels')}" data-tab="panels" role="tab" ...>${t('header.tabPanels')}</button>
```
Remove this line.

**Step 2: Remove the Panels tab panel content**

Remove the entire `#us-tab-panel-panels` div (lines 246-257) and its contents.

**Step 3: Remove panel-related methods**

Remove or skip:
- `renderPanelCategoryPills()` (lines 526-534)
- `renderPanelsTab()` (lines 536-547)
- `getAvailablePanelCategories()` (lines 482-498)
- `getVisiblePanelEntries()` (lines 500-524)
- `refreshPanelToggles()` if it exists

Also remove the panel toggle event delegation (lines 78-87, 96-101) and the reset layout button handler (lines 90-93).

**Step 4: Remove callbacks that are no longer needed**

From the UnifiedSettings constructor options, remove:
- `togglePanel`
- `getPanelSettings`
- `resetLayout`
- `getLocalizedPanelName`

Update `setupUnifiedSettings()` in `event-handlers.ts` to stop passing these callbacks.

**Step 5: Run type check**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

**Step 6: Visually verify**

Run: `npm run dev` and check:
- Settings modal no longer has a "Panels" tab
- Settings modal still has General, Sources, Status tabs
- All panel management works through "+" and layout tabs

**Step 7: Commit**

```bash
git add src/components/UnifiedSettings.ts src/app/event-handlers.ts
git commit -m "refactor: remove Settings > Panels tab, replaced by widget picker (#882)"
```

---

### Task 8: Write Tests for Layout Presets

**Files:**
- Create: `tests/layout-presets.test.mjs`

**Step 1: Write the test file**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Read the layouts source to validate presets reference valid panel keys
const layoutsSrc = readFileSync(resolve(root, 'src/config/layouts.ts'), 'utf-8');
const panelsSrc = readFileSync(resolve(root, 'src/config/panels.ts'), 'utf-8');

function extractPanelKeys(src, objectName) {
  const re = new RegExp(`const ${objectName}[^{]*\\{([\\s\\S]*?)\\n\\};`, 'm');
  const match = re.exec(src);
  if (!match) return [];
  const keys = [];
  const keyRe = /['"]([^'"]+)['"]\s*:/g;
  let m;
  while ((m = keyRe.exec(match[1])) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

function extractLayoutPanelKeys(src, arrayName) {
  const re = new RegExp(`const ${arrayName}[^\\[]*\\[([\\s\\S]*?)\\n\\];`, 'm');
  const match = re.exec(src);
  if (!match) return [];
  const layouts = [];
  const presetRe = /panelKeys:\s*\[([^\]]+)\]/g;
  let m;
  while ((m = presetRe.exec(match[1])) !== null) {
    const keys = m[1].match(/['"]([^'"]+)['"]/g)?.map(k => k.replace(/['"]/g, '')) || [];
    layouts.push(keys);
  }
  return layouts;
}

const fullPanelKeys = extractPanelKeys(panelsSrc, 'FULL_PANELS');
const techPanelKeys = extractPanelKeys(panelsSrc, 'TECH_PANELS');
const financePanelKeys = extractPanelKeys(panelsSrc, 'FINANCE_PANELS');
const happyPanelKeys = extractPanelKeys(panelsSrc, 'HAPPY_PANELS');

const fullLayouts = extractLayoutPanelKeys(layoutsSrc, 'FULL_LAYOUTS');
const techLayouts = extractLayoutPanelKeys(layoutsSrc, 'TECH_LAYOUTS');
const financeLayouts = extractLayoutPanelKeys(layoutsSrc, 'FINANCE_LAYOUTS');
const happyLayouts = extractLayoutPanelKeys(layoutsSrc, 'HAPPY_LAYOUTS');

describe('Layout presets reference valid panel keys', () => {
  it('FULL_LAYOUTS panels exist in FULL_PANELS', () => {
    for (const layout of fullLayouts) {
      for (const key of layout) {
        assert.ok(fullPanelKeys.includes(key), `Panel "${key}" in FULL_LAYOUTS not found in FULL_PANELS`);
      }
    }
  });

  it('TECH_LAYOUTS panels exist in TECH_PANELS', () => {
    for (const layout of techLayouts) {
      for (const key of layout) {
        assert.ok(techPanelKeys.includes(key), `Panel "${key}" in TECH_LAYOUTS not found in TECH_PANELS`);
      }
    }
  });

  it('FINANCE_LAYOUTS panels exist in FINANCE_PANELS', () => {
    for (const layout of financeLayouts) {
      for (const key of layout) {
        assert.ok(financePanelKeys.includes(key), `Panel "${key}" in FINANCE_LAYOUTS not found in FINANCE_PANELS`);
      }
    }
  });

  it('HAPPY_LAYOUTS panels exist in HAPPY_PANELS', () => {
    for (const layout of happyLayouts) {
      for (const key of layout) {
        assert.ok(happyPanelKeys.includes(key), `Panel "${key}" in HAPPY_LAYOUTS not found in HAPPY_PANELS`);
      }
    }
  });

  it('every layout includes the map panel', () => {
    for (const layouts of [fullLayouts, techLayouts, financeLayouts, happyLayouts]) {
      for (const layout of layouts) {
        assert.ok(layout.includes('map'), `Layout missing "map" panel: ${JSON.stringify(layout)}`);
      }
    }
  });

  it('no duplicate keys within a layout', () => {
    for (const layouts of [fullLayouts, techLayouts, financeLayouts, happyLayouts]) {
      for (const layout of layouts) {
        const unique = new Set(layout);
        assert.equal(unique.size, layout.length, `Duplicate keys in layout: ${JSON.stringify(layout)}`);
      }
    }
  });
});
```

**Step 2: Run tests**

Run: `node --test tests/layout-presets.test.mjs`
Expected: All tests pass

**Step 3: Commit**

```bash
git add tests/layout-presets.test.mjs
git commit -m "test: add layout presets validation tests (#882)"
```

---

### Task 9: Final Integration Verification

**Files:** None (verification only)

**Step 1: Run full test suite**

Run: `npm test 2>&1 | tail -20`
Expected: All tests pass

**Step 2: Run type check**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

**Step 3: Run dev server and manual verification**

Run: `npm run dev`

Verify:
- [ ] Layout tabs visible in header (between left controls and right controls)
- [ ] Clicking a layout tab switches visible panels
- [ ] "+" button visible in header-right
- [ ] Clicking "+" opens categorized popover
- [ ] Filter input narrows the panel list
- [ ] Toggling a panel in popover shows/hides it in the grid
- [ ] "x" button appears on panel headers on hover
- [ ] Clicking "x" removes the panel
- [ ] Modified indicator (dot) appears on layout tab after adding/removing panels
- [ ] Clicking the active modified tab resets to defaults
- [ ] Settings modal no longer has a Panels tab
- [ ] Layout selection persists across page reload
- [ ] Layout overrides persist across page reload
- [ ] Hidden on mobile (< 900px) — layout tabs

**Step 4: Commit any fixes**

If any issues found, fix and commit with descriptive message.
