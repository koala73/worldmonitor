import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationalExposureForm } from '@/components/OperationalExposureForm';
import type { OperationalSnapshot } from '@/types/operational-balance';

const click = (root: HTMLElement, label: string) => Array.from(root.querySelectorAll('button')).find(button => button.textContent === label)!.click();
const fill = (root: HTMLElement, label: string, value: string) => {
  const input = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
};
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('operational form', () => {
  it('edits the example through day 8/day 10, clears invalid results and exports actual balances', async () => {
    let current: OperationalSnapshot | null = null;
    const root = createOperationalExposureForm(value => { current = value; }); document.body.append(root);
    expect(root.textContent).toContain('Labeled example');
    expect(root.querySelector('.operational-summary')!.textContent).toContain('Baseline first gap: Day 8. Alternative first gap: Day 8.');
    click(root, 'Add alternative delivery');
    expect(root.querySelector('.operational-result')).toBeNull(); expect(current).toBeNull();
    fill(root, 'Alternative delivery date', '2026-09-17'); fill(root, 'Alternative delivery quantity', '40');
    expect(root.querySelector('.operational-summary')!.textContent).toContain('Alternative first gap: Day 10');
    expect(Array.from(root.querySelectorAll('[data-day="8"] td')).map(cell => cell.textContent)).toEqual(['0', '20', '0', '20', '40', '20', '20', '0']);
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:test'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    click(root, 'Export worksheet JSON');
    const exported = JSON.parse(await blobs[0]!.text());
    expect(exported).toEqual(current); expect(exported.baseline.firstGapDay).toBe(8); expect(exported.alternative.firstGapDay).toBe(10);
    fill(root, 'Starting usable stock', '');
    expect(current).toBeNull(); expect(root.querySelector('.operational-result')).toBeNull();
    expect(root.textContent).toContain('Starting stock is required');
    expect(Array.from(root.querySelectorAll('button')).find(button => button.textContent === 'Export worksheet JSON')!.disabled).toBe(true);
    fill(root, 'Starting usable stock', '100'); expect(root.textContent).toContain('Alternative first gap: Day 10');
  });

  it('imports through the real file control and rejects malformed/oversized input without replacing work', async () => {
    const root = createOperationalExposureForm(() => {}); document.body.append(root);
    const file = root.querySelector<HTMLInputElement>('input[type=file]')!;
    const upload = async (text: string) => {
      Object.defineProperty(file, 'files', { configurable: true, value: [new File([text], 'worksheet.json', { type: 'application/json' })] });
      file.dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(root.textContent).toMatch(/Worksheet imported|Import rejected/));
    };
    const input = { operation: 'Imported operation', basis: 'user', unit: 'kg', startDate: '2026-10-01', horizonDays: 2, startingStock: 5, dailyDemand: 4, deliveries: [], alternativeDeliveries: [], alternativeDailyDemand: 2 };
    await upload(JSON.stringify({ schema: 'worldmonitor-operational-worksheet/v1', input }));
    expect(root.querySelector('.operational-summary')!.textContent).toContain('Total unmet demand: 3 → 0 kg');
    await upload('{'); expect(root.textContent).toContain('Import rejected');
    expect(root.querySelector<HTMLInputElement>('[aria-label="Operation name"]')!.value).toBe('Imported operation');
    await upload(' '.repeat(65537)); expect(root.textContent).toContain('64 KiB');
    expect(root.querySelector('.operational-summary')!.textContent).toContain('Total unmet demand: 3 → 0 kg');
  });
});

it('retains valid and incomplete drafts when the worksheet view is reopened', () => {
  const session = {};
  const first = createOperationalExposureForm(() => {}, session);
  fill(first, 'Starting usable stock', '200');
  const reopened = createOperationalExposureForm(() => {}, session);
  expect(reopened.querySelector<HTMLInputElement>('[aria-label="Starting usable stock"]')!.value).toBe('200');
  expect(reopened.querySelector('.operational-summary')!.textContent).toContain('Baseline first gap: None within horizon');
  fill(reopened, 'Daily demand', '');
  const incomplete = createOperationalExposureForm(() => {}, session);
  expect(incomplete.querySelector<HTMLInputElement>('[aria-label="Daily demand"]')!.value).toBe('');
  expect(incomplete.querySelector('.operational-result')).toBeNull();
  expect(incomplete.textContent).toContain('Daily demand is required');
});

it('does not let a pending import overwrite a later edit or an aborted view', async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController();
    const session = {};
    const root = createOperationalExposureForm(() => {}, session, controller.signal);
    let resolve!: (value: string) => void;
    const file = root.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(file, 'files', { configurable: true, value: [{ size: 1, text: () => new Promise<string>(done => { resolve = done; }) }] });
    file.dispatchEvent(new Event('change'));
    if (abort) controller.abort(); else fill(root, 'Starting usable stock', '200');
    resolve(JSON.stringify({ schema: 'worldmonitor-operational-worksheet/v1', input: { operation: 'Late import', basis: 'user', unit: 'kg', startDate: '2026-10-01', horizonDays: 2, startingStock: 0, dailyDemand: 1, deliveries: [], alternativeDeliveries: [], alternativeDailyDemand: null } }));
    await new Promise(done => setTimeout(done, 0));
    const reopened = createOperationalExposureForm(() => {}, session);
    expect(reopened.querySelector<HTMLInputElement>('[aria-label="Operation name"]')!.value).toBe('Example operation');
    expect(reopened.querySelector<HTMLInputElement>('[aria-label="Starting usable stock"]')!.value).toBe(abort ? '100' : '200');
  }
});
