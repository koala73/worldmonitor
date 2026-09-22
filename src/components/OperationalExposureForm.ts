import type { OperationalInput, OperationalSnapshot } from '@/types/operational-balance';
import { calculateOperationalBalance, importOperationalWorksheet, MAX_OPERATIONAL_DELIVERIES, MAX_OPERATIONAL_JSON_BYTES, operationalExample } from '@/utils/operational-balance';
import { h } from '@/utils/dom-utils';

interface OperationalDraft extends Omit<OperationalInput, 'startingStock' | 'dailyDemand' | 'horizonDays' | 'deliveries' | 'alternativeDeliveries'> {
  startingStock: number | null;
  dailyDemand: number | null;
  horizonDays: number | null;
  deliveries: { date: string; quantity: number | null; unit: string; costUsd: number | null }[];
  alternativeDeliveries: OperationalDraft['deliveries'];
}

export interface OperationalWorksheetSession {
  draft?: OperationalDraft;
}

export function renderOperationalWorksheet(snapshot: OperationalSnapshot): HTMLElement {
  const { input, baseline, alternative } = snapshot;
  const gap = (day: number | null) => day === null ? 'None within horizon' : `Day ${day}`;
  const root = h('section', { className: 'operational-result', 'aria-label': 'Daily operational balance', lang: 'en' },
    h('div', { className: 'operational-result-heading' }, h('h3', {}, 'Daily balance'), h('span', {}, `${input.horizonDays} days · ${input.unit}`)),
    h('p', { className: 'operational-operation' }, input.operation),
    h('div', { className: 'operational-summary' },
      h('p', { className: 'operational-scenario' }, h('span', {}, 'Baseline first gap: '), h('strong', {}, `${gap(baseline.firstGapDay)}. `)),
      h('p', { className: 'operational-scenario operational-scenario-alt' }, h('span', {}, 'Alternative first gap: '), h('strong', {}, `${gap(alternative.firstGapDay)}. `)),
      h('p', { className: 'operational-unmet' }, `Total unmet demand: ${baseline.totalUnmetDemand} → ${alternative.totalUnmetDemand} ${input.unit}. `,
        h('span', {}, `Avoided unmet demand: ${snapshot.avoidedUnmetDemand} ${input.unit}.`))),
    h('p', { className: 'operational-cost' }, snapshot.additionalDeliveryCostUsd === null ? 'Delivery cost comparison unavailable. One or more prices are unknown.' : `Additional delivery spending: ${snapshot.additionalDeliveryCostUsd} USD. This excludes operating costs and the value of unmet demand.`),
  );
  const assumptions = h('details', { className: 'operational-method' }, h('summary', {}, 'Assumptions & delivery details'),
    h('p', {}, input.basis === 'example' ? 'Labeled example. Edit these assumptions; actual operating data is optional.' : 'User assumptions. These values are not WorldMonitor observations.'),
    h('p', {}, `Unit: ${input.unit}. Starting usable stock: ${input.startingStock}. Start: ${input.startDate}. Horizon: ${input.horizonDays} days.`),
    h('p', {}, 'Deliveries become usable at the start of the selected day. Remaining stock carries forward. Unmet demand is recorded daily and is not carried as backlog; later deliveries cannot erase an earlier gap.'),
    h('p', {}, 'Alternative includes baseline deliveries plus additional deliveries and the selected alternative daily demand. This is a conditional stock balance, not a shutdown forecast. Delivery feasibility and supplier capacity remain unverified. WorldMonitor country and route context is separate from these assumptions.'));
  for (const [label, rows] of [['Baseline deliveries', input.deliveries], ['Additional alternative deliveries', input.alternativeDeliveries]] as const) {
    assumptions.append(h('h4', {}, label), h('ul', {}, ...(rows.length ? rows.map(row => h('li', {}, `${row.date}: ${row.quantity} ${row.unit}; total cost ${row.costUsd === null ? 'unknown' : `${row.costUsd} USD`}`)) : [h('li', {}, 'None')])));
  }
  const table = h('table', {}, h('caption', {}, `Daily balance in ${input.unit}`),
    h('thead', {}, h('tr', {}, ...['Day / date', 'Baseline arrivals', 'Baseline demand', 'Baseline stock', 'Baseline unmet', 'Alternative arrivals', 'Alternative demand', 'Alternative stock', 'Alternative unmet'].map(label => h('th', { scope: 'col' }, label)))));
  table.append(h('tbody', {}, ...baseline.days.map((day, index) => {
    const alt = alternative.days[index]!;
    return h('tr', { 'data-day': day.day }, h('th', { scope: 'row' }, `${day.day} / ${day.date}`), ...[day.arrivals, day.demand, day.closingStock, day.unmetDemand, alt.arrivals, alt.demand, alt.closingStock, alt.unmetDemand].map(value => h('td', {}, String(value))));
  })));
  root.append(h('div', { className: 'operational-table', tabindex: 0, role: 'region', 'aria-label': 'Scrollable daily balance' }, table),
    h('p', { className: 'operational-note' }, 'User assumptions · Conditional stock balance, not a shutdown forecast.'), assumptions);
  return root;
}

export function createOperationalExposureForm(onChange: (snapshot: OperationalSnapshot | null) => void, session: OperationalWorksheetSession = {}, signal?: AbortSignal): HTMLElement {
  const root = h('section', { className: 'operational-worksheet', 'aria-label': 'Operational what-if worksheet', lang: 'en' });
  const fields = h('div', { className: 'operational-fields' });
  const editor = h('div', { className: 'operational-editor' });
  const actions = h('div', { className: 'operational-actions' });
  const alternativeFields = h('div', { className: 'operational-fields operational-alternative-fields' });
  const baselineRows = h('div');
  const alternativeRows = h('div');
  const result = h('div');
  const error = h('p', { className: 'operational-error', 'aria-live': 'polite' });
  const importStatus = h('p', { className: 'operational-import-status', 'aria-live': 'polite' });
  let basis: OperationalInput['basis'] = 'example';
  let snapshot: OperationalSnapshot | null = null;
  let revision = 0;
  let importGeneration = 0;
  const setNumber = (field: HTMLInputElement, value: number | null) => {
    field.value = value === null || Number.isNaN(value) ? '' : String(value);
    field.setCustomValidity(Number.isNaN(value) ? 'Enter a valid number.' : '');
  };
  const input = (label: string, type: string, parent: HTMLElement, value = '') => {
    const field = h('input', { type, value, 'aria-label': label, ...(type === 'number' ? { min: 0, max: 1e6, step: 'any' } : {}) }) as HTMLInputElement;
    if (type === 'number') setNumber(field, value === '' ? null : Number(value));
    parent.append(h('label', {}, h('span', {}, label), field));
    return field;
  };
  const operation = input('Operation name', 'text', fields);
  operation.maxLength = 100;
  const unit = input('Quantity unit', 'text', fields);
  unit.maxLength = 24;
  const start = input('Start date', 'date', fields);
  const horizon = input('Horizon days', 'number', fields);
  horizon.max = '90'; horizon.min = '1'; horizon.step = '1';
  const stock = input('Starting usable stock', 'number', fields);
  const demand = input('Daily demand', 'number', fields);
  const alternativeDemand = input('Alternative daily demand (blank keeps baseline)', 'number', alternativeFields);
  const numeric = (field: HTMLInputElement) => field.validity.badInput || field.validity.customError ? NaN : field.value === '' ? null : Number(field.value);
  const rows = (parent: HTMLElement) => Array.from(parent.children).map(row => {
    const [date, quantity, cost] = Array.from(row.querySelectorAll('input'));
    return { date: date!.value, quantity: numeric(quantity!), unit: unit.value.trim(), costUsd: numeric(cost!) };
  });
  const exportButton = h('button', { type: 'button', className: 'cdp-action-btn cdp-export-primary' }, 'Export worksheet JSON') as HTMLButtonElement;
  const update = () => {
    revision++;
    session.draft = { operation: operation.value, basis, unit: unit.value, startDate: start.value, horizonDays: numeric(horizon), startingStock: numeric(stock), dailyDemand: numeric(demand), alternativeDailyDemand: numeric(alternativeDemand), deliveries: rows(baselineRows), alternativeDeliveries: rows(alternativeRows) };
    try {
      snapshot = calculateOperationalBalance(session.draft);
      result.replaceChildren(renderOperationalWorksheet(snapshot)); error.textContent = ''; exportButton.disabled = false;
    } catch (cause) {
      snapshot = null; result.replaceChildren(); error.textContent = `Worksheet incomplete or invalid. ${cause instanceof Error ? cause.message : 'Check the inputs.'}`; exportButton.disabled = true;
    }
    onChange(snapshot);
  };
  const addRow = (parent: HTMLElement, label: string, row?: OperationalDraft['deliveries'][number]) => {
    if (parent.children.length >= MAX_OPERATIONAL_DELIVERIES) { importStatus.textContent = 'Use at most 30 deliveries per list.'; return; }
    const group = h('div', { className: 'operational-delivery' });
    input(`${label} date`, 'date', group, row?.date ?? start.value);
    input(`${label} quantity`, 'number', group, row?.quantity == null ? '' : String(row.quantity));
    input(`${label} total cost USD (optional)`, 'number', group, row?.costUsd == null ? '' : String(row.costUsd));
    const remove = h('button', { type: 'button', className: 'cdp-action-btn', 'aria-label': `Remove ${label.toLowerCase()}` }, 'Remove');
    remove.addEventListener('click', () => { group.remove(); basis = 'user'; update(); });
    group.append(remove); parent.append(group);
  };
  const populate = (data: OperationalDraft) => {
    basis = data.basis; operation.value = data.operation; unit.value = data.unit; start.value = data.startDate;
    setNumber(horizon, data.horizonDays);
    setNumber(stock, data.startingStock);
    setNumber(demand, data.dailyDemand);
    setNumber(alternativeDemand, data.alternativeDailyDemand);
    baselineRows.replaceChildren(); alternativeRows.replaceChildren();
    data.deliveries.forEach(row => addRow(baselineRows, 'Baseline delivery', row));
    data.alternativeDeliveries.forEach(row => addRow(alternativeRows, 'Alternative delivery', row));
    update();
  };
  for (const [parent, label] of [[baselineRows, 'Baseline delivery'], [alternativeRows, 'Alternative delivery']] as const) {
    const add = h('button', { type: 'button', className: 'cdp-action-btn' }, `Add ${label.toLowerCase()}`);
    add.addEventListener('click', () => { addRow(parent, label); basis = 'user'; update(); });
    const section = h('section', { className: 'operational-input-section' },
      h('div', { className: 'operational-section-heading' }, h('h3', {}, label === 'Baseline delivery' ? 'Baseline deliveries' : 'Alternative plan'), add));
    if (parent === alternativeRows) section.append(alternativeFields);
    section.append(parent);
    editor.append(section);
  }
  editor.prepend(h('section', { className: 'operational-input-section' }, h('h3', {}, 'Operation inputs'), fields));
  root.append(h('header', { className: 'operational-header' },
    h('p', { className: 'operational-eyebrow' }, 'LOCAL WORKSHEET'),
    h('h2', { className: 'cdp-card-title' }, 'Operational what-if'),
    h('p', { className: 'cdp-section-description' }, 'Compare usable stock, daily demand and delivery timing. Edit the labeled example to test your assumptions.')));
  root.addEventListener('input', event => {
    if (event.target instanceof HTMLInputElement && event.target.type !== 'file') { event.target.setCustomValidity(''); basis = 'user'; update(); }
  });
  const file = input('Import worksheet JSON', 'file', actions);
  file.accept = '.json,application/json';
  file.addEventListener('change', async () => {
    const selected = file.files?.[0];
    if (!selected) return;
    const current = revision;
    const generation = ++importGeneration;
    try {
      if (selected.size > MAX_OPERATIONAL_JSON_BYTES) throw new Error('Worksheet JSON must be no larger than 64 KiB.');
      const imported = importOperationalWorksheet(await selected.text());
      if (signal?.aborted || generation !== importGeneration) return;
      if (current !== revision) throw new Error('Inputs changed while reading. Select the file again to import.');
      populate(imported.input); importStatus.textContent = 'Worksheet imported. Results recalculated from its inputs.';
    } catch (cause) {
      importStatus.textContent = `Import rejected; your inputs are unchanged. ${cause instanceof Error ? cause.message : 'Invalid JSON.'}`;
    } finally { if (generation === importGeneration) file.value = ''; }
  });
  exportButton.addEventListener('click', () => {
    if (!snapshot) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    h('a', { href: url, download: 'operational-worksheet.json' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });
  actions.append(exportButton);
  root.append(actions, importStatus,
    h('details', { className: 'operational-method operational-input-help' }, h('summary', {}, 'How this worksheet works'),
      h('p', {}, 'Actual operating data is optional. Inputs stay in browser memory until page reload; export JSON to keep them. Use one unit for all quantities. Changing the unit relabels all quantities; it does not convert them. Up to 90 days and 30 deliveries per list. Quantities and costs allow 0-1 million with up to 6 decimal places.')),
    h('div', { className: 'operational-workspace' }, editor, h('div', { className: 'operational-results' }, error, result)));
  populate(session.draft ?? operationalExample());
  return root;
}
