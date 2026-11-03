// Shared view scaffolding: a view with focusable panes, each holding a ListView.
import { ListView } from '../ui/widgets.mjs';
import { describeItem } from '../ui/detail.mjs';

export class PaneView {
  constructor(app, { id, label, paneIds = [], sources = [] }) {
    this.app = app;
    this.id = id;
    this.label = label;
    this.paneIds = paneIds;
    this.focus = 0;
    this.lists = Object.fromEntries(paneIds.map((p) => [p, new ListView()]));
    this.sourceIds = sources;
    // Panes the last frame drew; narrow layouts leave some out.
    this.drawing = new Set();
    this.drawn = new Set(paneIds);
  }

  // The app brackets each render so focus only visits panes on screen.
  beginFrame() {
    this.drawing = new Set();
  }

  endFrame() {
    this.drawn = this.drawing;
    if (this.drawn.size && !this.drawn.has(this.focusedPane)) this.focus = this.paneIds.findIndex((p) => this.drawn.has(p));
  }

  moveFocus(step) {
    const n = this.paneIds.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.focus + step * k + n * k) % n;
      if (!this.drawn.size || this.drawn.has(this.paneIds[i])) {
        this.focus = i;
        return;
      }
    }
  }

  get store() {
    return this.app.store;
  }

  get data() {
    return this.app.store.data;
  }

  get focusedPane() {
    return this.paneIds[this.focus];
  }

  isFocused(paneId) {
    return this.paneIds[this.focus] === paneId;
  }

  focusPane(paneId) {
    const i = this.paneIds.indexOf(paneId);
    if (i >= 0) this.focus = i;
  }

  sources() {
    return this.sourceIds;
  }

  mount() {
    for (const id of this.sourceIds) if (this.store.sources[id]?.lazy) this.store.want(id, true);
  }

  unmount() {
    for (const id of this.sourceIds) if (this.store.sources[id]?.lazy) this.store.want(id, false);
  }

  // Default key handling: left/right (h/l) move focus; the focused list handles the rest.
  onKey(ev) {
    if (ev.name === 'right' || ev.name === 'l') {
      this.moveFocus(1);
      return true;
    }
    if (ev.name === 'left' || ev.name === 'h') {
      this.moveFocus(-1);
      return true;
    }
    if (ev.name === 'enter') {
      this.activate(this.focusedPane);
      return true;
    }
    const list = this.lists[this.focusedPane];
    if (list && list.handleKey(ev)) return true;
    return false;
  }

  // Items currently listed in a pane. Views override this so Enter / click can
  // expand the selected row; `describe(item, pane)` customises the detail.
  items(pane) {
    const list = this.lists[pane];
    return list && Array.isArray(list.items) ? list.items : null;
  }

  describe(item, pane) {
    return describeItem(item, { subtitle: this.paneTitle ? this.paneTitle(pane) : `${this.label} · ${pane}` });
  }

  // Enter / second click on the selected row of a pane: expand it.
  activate(pane) {
    const items = this.items(pane);
    const item = items && items.length ? selectedItem(this.lists[pane], items) : null;
    if (!item) return;
    if (item.header && Object.keys(item).length === 1) {
      this.lists[pane].move(1); // group header rows are not records: step onto the first row
      return;
    }
    this.app.openDetail(this.describe(item, pane));
  }

  // Common list options wiring focus and activation.
  listOpts(paneId, extra = {}) {
    this.drawing.add(paneId);
    return {
      focused: this.isFocused(paneId),
      onFocus: () => this.focusPane(paneId),
      onActivate: () => this.activate(paneId),
      ...extra,
    };
  }

  selectedUrl() {
    return null;
  }

  hints() {
    return '';
  }
}

export function selectedItem(list, items) {
  return items && items.length ? items[Math.min(list.selected, items.length - 1)] : null;
}
