/**
 * Cargo type dropdown with auto-infer indicator. The user can override the
 * auto-inferred value at any time.
 */

import type { ExplorerCargo } from './RouteExplorer.utils';

export interface CargoTypeDropdownOptions {
  initialCargo?: ExplorerCargo | null;
  initialAutoInferred?: boolean;
  onChange: (cargo: ExplorerCargo, manual: boolean) => void;
}

const CARGO_LABELS: Record<ExplorerCargo, string> = {
  container: 'Container',
  tanker: 'Tanker',
  bulk: 'Bulk',
  roro: 'RoRo',
};

export class CargoTypeDropdown {
  public readonly element: HTMLDivElement;
  private select: HTMLSelectElement;
  private autoBadge: HTMLSpanElement;

  constructor(opts: CargoTypeDropdownOptions) {
    this.element = document.createElement('div');
    this.element.className = 're-cargo';

    this.select = document.createElement('select');
    this.select.className = 're-cargo__select';
    this.select.setAttribute('aria-label', 'Cargo type');
    for (const [value, label] of Object.entries(CARGO_LABELS) as Array<
      [ExplorerCargo, string]
    >) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      this.select.append(opt);
    }
    if (opts.initialCargo) this.select.value = opts.initialCargo;

    this.autoBadge = document.createElement('span');
    this.autoBadge.className = 're-cargo__auto';
    this.autoBadge.textContent = 'auto';
    this.autoBadge.title = 'Inferred from selected product';
    if (!opts.initialAutoInferred) this.autoBadge.style.display = 'none';

    this.element.append(this.select, this.autoBadge);

    this.select.addEventListener('change', () => {
      this.autoBadge.style.display = 'none';
      opts.onChange(this.select.value as ExplorerCargo, true);
    });
  }

  public setAutoInferred(cargo: ExplorerCargo): void {
    this.select.value = cargo;
    this.autoBadge.style.display = '';
  }
}
