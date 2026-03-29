/**
 * Resource Inventory Panel
 *
 * Tracks survival supplies with days-remaining estimates.
 * Data persists via IndexedDB (`worldmonitor-resources` store).
 *
 * Color coding:
 *  - Green  (>7 days)
 *  - Yellow (3–7 days)
 *  - Red    (<3 days)  → triggers Tauri desktop notification
 *
 * Supports JSON import/export for offline backup.
 */

import { Panel } from '@/components/Panel';
import { tryInvokeTauri } from '@/services/tauri-bridge';
import { isDesktopRuntime } from '@/services/runtime';

const DB_NAME = 'worldmonitor-resources';
const STORE_NAME = 'items';
const DB_VERSION = 1;

export interface ResourceItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  dailyRate: number;   // consumption per day
  category: string;
  lastUpdated: number; // Unix ms
}

// ── IndexedDB helpers ──────────────────────────────────────────────────────

let _db: IDBDatabase | null = null;

async function openDB(): Promise<IDBDatabase> {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    req.onsuccess = () => { _db = req.result; resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}

const MAX_ITEMS = 5000; // hard cap — prevents OOM on runaway imports

async function getAllItems(): Promise<ResourceItem[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    // Pass undefined as the key query (no filter) and MAX_ITEMS as count cap.
    // IDBObjectStore.getAll(query?, count?) — count prevents unbounded memory load.
    const req = tx.objectStore(STORE_NAME).getAll(undefined, MAX_ITEMS);
    req.onsuccess = () => resolve(req.result as ResourceItem[]);
    req.onerror = () => reject(req.error);
  });
}

async function putItem(item: ResourceItem): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function deleteItem(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── Panel ──────────────────────────────────────────────────────────────────

export class ResourceInventoryPanel extends Panel {
  private _items: ResourceItem[] = [];
  private _editingId: string | null = null;

  constructor() {
    super({
      id: 'resource-inventory',
      title: '🎒 Resource Inventory',
      infoTooltip: 'Track survival supplies. Estimates days remaining based on daily consumption rate. Color-coded: green >7d, yellow 3–7d, red <3d.',
    });
    void this._load();
  }

  private async _load(): Promise<void> {
    try {
      this._items = await getAllItems();
      this._items.sort((a, b) => this._daysLeft(a) - this._daysLeft(b));
      this._render();
      if (isDesktopRuntime()) void this._notifyLowStock();
    } catch {
      this.showError('Unable to load inventory. Storage may be unavailable.');
    }
  }

  private _daysLeft(item: ResourceItem): number {
    if (item.dailyRate <= 0) return Infinity;
    return item.quantity / item.dailyRate;
  }

  private _daysClass(days: number): string {
    if (days === Infinity || days > 7) return 'ri-days-ok';
    if (days >= 3) return 'ri-days-warn';
    return 'ri-days-crit';
  }

  private _daysLabel(days: number): string {
    if (days === Infinity) return '∞';
    return `${days.toFixed(1)}d`;
  }

  private _render(): void {
    if (this._editingId !== null) {
      this._renderForm(this._editingId);
      return;
    }

    const rows = this._items.map(item => {
      const days = this._daysLeft(item);
      const cls = this._daysClass(days);
      return `
        <tr>
          <td>${this._esc(item.name)}</td>
          <td>${item.quantity} ${this._esc(item.unit)}</td>
          <td>${item.dailyRate > 0 ? `${item.dailyRate}/${this._esc(item.unit)}/d` : '—'}</td>
          <td class="${cls}">${this._daysLabel(days)}</td>
          <td>${this._esc(item.category)}</td>
          <td>
            <button class="ri-edit-btn" data-id="${item.id}" title="Edit">✏</button>
            <button class="ri-del-btn" data-id="${item.id}" title="Delete">🗑</button>
          </td>
        </tr>
      `;
    }).join('');

    const html = `
      <div class="ri-wrap">
        <div class="ri-toolbar">
          <button class="ri-btn ri-btn-add" id="riAddBtn">+ Add Item</button>
          <button class="ri-btn ri-btn-export" id="riExportBtn">Export JSON</button>
          <label class="ri-btn" style="cursor:pointer">
            Import JSON
            <input type="file" accept=".json" id="riImportFile" style="display:none">
          </label>
        </div>
        ${this._items.length === 0
          ? '<div class="ri-empty">No items yet. Add water, food, medication and other supplies.</div>'
          : `<table class="ri-table">
              <thead><tr>
                <th>Item</th><th>Qty</th><th>Rate</th><th>Days</th><th>Category</th><th></th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>`
        }
      </div>
    `;
    this.setContent(html);
    this._attachListeners();
  }

  private _renderForm(id: string | null): void {
    const existing = id ? this._items.find(i => i.id === id) : null;
    const html = `
      <div class="ri-wrap">
        <form id="riForm" class="rdp-inputs">
          <label class="rdp-label">Name
            <input class="rdp-input" style="width:100%" name="name" required value="${existing ? this._esc(existing.name) : ''}">
          </label>
          <label class="rdp-label">Quantity
            <input class="rdp-input" name="quantity" type="number" min="0" step="any" value="${existing ? existing.quantity : ''}">
          </label>
          <label class="rdp-label">Unit (e.g. L, kg, tablets)
            <input class="rdp-input" name="unit" value="${existing ? this._esc(existing.unit) : ''}">
          </label>
          <label class="rdp-label">Daily consumption rate (same unit/day)
            <input class="rdp-input" name="dailyRate" type="number" min="0" step="any" value="${existing ? existing.dailyRate : ''}">
          </label>
          <label class="rdp-label">Category
            <input class="rdp-input" name="category" value="${existing ? this._esc(existing.category) : 'Food'}">
          </label>
          <div style="display:flex;gap:6px;margin-top:4px">
            <button type="submit" class="ri-btn ri-btn-add">Save</button>
            <button type="button" class="ri-btn" id="riCancelBtn">Cancel</button>
          </div>
        </form>
      </div>
    `;
    this.setContent(html);

    const el = this.getContentElement();
    if (!el) return;

    el.querySelector('#riCancelBtn')?.addEventListener('click', () => {
      this._editingId = null;
      this._render();
    });

    el.querySelector<HTMLFormElement>('#riForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const data = new FormData(form);
      const item: ResourceItem = {
        id: existing?.id ?? crypto.randomUUID(),
        name: (data.get('name') as string).trim(),
        quantity: Number.parseFloat(data.get('quantity') as string) || 0,
        unit: (data.get('unit') as string).trim() || 'units',
        dailyRate: Number.parseFloat(data.get('dailyRate') as string) || 0,
        category: (data.get('category') as string).trim() || 'Misc',
        lastUpdated: Date.now(),
      };
      void putItem(item).then(() => {
        this._editingId = null;
        void this._load();
      });
    });
  }

  private _attachListeners(): void {
    const el = this.getContentElement();
    if (!el) return;

    el.querySelector('#riAddBtn')?.addEventListener('click', () => {
      this._editingId = 'new';
      this._renderForm(null);
    });

    el.querySelector('#riExportBtn')?.addEventListener('click', () => {
      const json = JSON.stringify(this._items, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `worldmonitor-resources-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    el.querySelector<HTMLInputElement>('#riImportFile')?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.addEventListener('load', async () => {
        try {
          const parsed = JSON.parse(reader.result as string) as ResourceItem[];
          for (const item of parsed) {
            if (item.id && item.name) await putItem(item);
          }
          void this._load();
        } catch { /* malformed JSON */ }
      });
      reader.readAsText(file);
    });

    el.querySelectorAll<HTMLButtonElement>('.ri-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._editingId = btn.dataset.id ?? null;
        this._renderForm(this._editingId);
      });
    });

    el.querySelectorAll<HTMLButtonElement>('.ri-del-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (id) void deleteItem(id).then(() => void this._load());
      });
    });
  }

  private async _notifyLowStock(): Promise<void> {
    const low = this._items.filter(i => {
      const d = this._daysLeft(i);
      return d !== Infinity && d < 3;
    });
    if (low.length === 0) return;
    const names = low.slice(0, 3).map(i => i.name).join(', ');
    await tryInvokeTauri<void>('send_notification', {
      title: '⚠ World Monitor — Low Stock Alert',
      body: `${low.length} item(s) have <3 days remaining: ${names}`,
      sound: 'Ping',
    }).catch(() => {});
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
