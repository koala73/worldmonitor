/**
 * T2 (#5634) — the Export PDF click cycle, composed.
 *
 * `tests/export-pdf-report.test.mts` covers each stage in isolation:
 * `buildDataReportDocument` against a fixture, and `printReportDocument`
 * against an INJECTED fake document. Nothing joined them — so the wiring
 * between the menu button, `exportToPDF`, the builder and the real print
 * surface was unproven, and so was every state transition the button makes
 * while the report is in flight.
 *
 * This file clicks the actual "Export PDF" option in a mounted `ExportPanel`
 * and asserts what reached the printed document, with no dependency injection
 * anywhere in the chain. happy-dom has no `window.print()`, so the harness
 * shims one that records the document it was called on — see
 * `helpers/print-recorder.mts`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';

import { ExportPanel, type ExportData } from '@/utils/export';

import { initTestI18n, tt } from './helpers/i18n.mts';
import { installPrintRecorder, type PrintRecorder } from './helpers/print-recorder.mts';

/**
 * Mirrors `printReportDocument`'s own defaults (`deps.printDelayMs ?? 300`,
 * `deps.cleanupDelayMs ?? 5000`). They are inline literals over there, so
 * nothing links these to them — `clickExportPdf` below therefore asserts the
 * cycle actually settled, so a raised production delay fails with a message
 * naming the cause instead of an opaque "printed is empty".
 */
const PRINT_DELAY_MS = 300;
const CLEANUP_DELAY_MS = 5000;

const TS = Date.parse('2026-07-25T12:00:00.000Z');

function exportData(overrides: Partial<ExportData> = {}): ExportData {
  return {
    meta: { exportedAt: '2026-07-25T12:00:00.000Z', note: 'Export reflects all active sources.' },
    timestamp: TS,
    news: [
      {
        source: 'Reuters',
        title: 'Baseline headline',
        link: 'https://example.com/a',
        pubDate: new Date(TS),
        isAlert: false,
      },
    ],
    ...overrides,
  } as ExportData;
}

let recorder: PrintRecorder;
let panel: ExportPanel;
let getData: Mock<() => ExportData>;
let warnSpy: MockInstance<typeof console.warn>;

const root = () => panel.getElement();
const trigger = () => root().querySelector<HTMLButtonElement>('.export-btn')!;
const menu = () => root().querySelector<HTMLElement>('.export-menu')!;
const pdfOption = () => root().querySelector<HTMLButtonElement>('.export-option[data-format="pdf"]')!;
const frames = () => document.body.querySelectorAll('iframe');
const toast = () => document.querySelector<HTMLElement>('.toast-notification');

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
  recorder = installPrintRecorder();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  getData = vi.fn<() => ExportData>(() => exportData());
  panel = new ExportPanel(getData);
  document.body.appendChild(root());
  trigger().click(); // open the menu
});

afterEach(() => {
  recorder.restore();
  warnSpy.mockRestore();
  vi.useRealTimers();
  document.body.replaceChildren();
});

/** Run the whole click → build → print cycle to completion. */
async function clickExportPdf(): Promise<void> {
  pdfOption().click();
  await vi.advanceTimersByTimeAsync(PRINT_DELAY_MS);
  // The button is restored in a `finally`, so it is false on BOTH the success
  // and failure paths once the cycle settles. Still busy means we did not
  // advance far enough — i.e. PRINT_DELAY_MS no longer matches production.
  if (pdfOption().disabled) {
    throw new Error(
      `[export-pdf-cycle] cycle had not settled after ${PRINT_DELAY_MS}ms — ` +
        "printReportDocument's printDelayMs default has probably changed",
    );
  }
}

describe('Export PDF click cycle — button to printed document', () => {
  it('prints a report built from the data the panel holds at CLICK time', async () => {
    // Not construction time: the dashboard mutates constantly, and a report
    // built from a stale snapshot is the whole reason getData is a callback.
    getData.mockReturnValue(exportData({ news: [
      { source: 'AFP', title: 'Fresh headline at click time', link: 'https://example.com/b', pubDate: new Date(TS), isAlert: false },
    ] } as Partial<ExportData>));

    await clickExportPdf();

    expect(getData).toHaveBeenCalledTimes(1);
    expect(recorder.printed).toHaveLength(1);
    expect(recorder.printed[0]).toContain('Fresh headline at click time');
    expect(recorder.printed[0]).toContain('AFP');
  });

  it('carries the report chrome through the whole chain', async () => {
    await clickExportPdf();

    expect(recorder.printed[0]).toContain('Baseline headline');
    expect(recorder.printed[0]).toContain('Export reflects all active sources.');
  });

  it('escapes untrusted feed strings on the way to the printed document', async () => {
    getData.mockReturnValue(exportData({ news: [
      {
        source: 'Reuters',
        title: '<script>alert(1)</script> headline',
        link: 'https://example.com/a',
        pubDate: new Date(TS),
        isAlert: false,
      },
    ] } as Partial<ExportData>));

    await clickExportPdf();

    // The composed proof the per-stage tests could not give: no script element
    // survives into the document that actually gets printed.
    const printedDoc = document.createElement('div');
    printedDoc.innerHTML = recorder.printed[0]!;
    expect(printedDoc.querySelector('script')).toBeNull();
    expect(recorder.printed[0]).toContain('&lt;script&gt;');
  });

  it('strips LLM threat annotations, and only those, on the way to the report', async () => {
    // The stripper keys on threat.source === 'llm' so AI output cannot feed
    // back into itself. Keyword/ML classifications are intentionally kept —
    // asserting both halves keeps a blanket "drop every threat" from passing.
    getData.mockReturnValue(exportData({ news: [
      {
        source: 'Reuters',
        title: 'LLM-annotated headline',
        link: 'https://example.com/a',
        pubDate: new Date(TS),
        isAlert: false,
        threat: { level: 'high', category: 'LLM_ONLY_CATEGORY', source: 'llm' },
      },
      {
        source: 'AFP',
        title: 'Keyword-annotated headline',
        link: 'https://example.com/b',
        pubDate: new Date(TS),
        isAlert: false,
        threat: { level: 'medium', category: 'KEYWORD_CATEGORY', source: 'keyword' },
      },
    ] } as unknown as Partial<ExportData>));

    await clickExportPdf();

    expect(recorder.printed[0]).toContain('LLM-annotated headline');
    expect(recorder.printed[0]).not.toContain('LLM_ONLY_CATEGORY');
    expect(recorder.printed[0]).toContain('KEYWORD_CATEGORY');
  });

  it('prints through an offscreen, AT-invisible iframe', async () => {
    pdfOption().click();

    const frame = frames()[0]!;
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    expect(frame.style.position).toBe('fixed');
    expect(frame.style.left).toBe('-9999px');

    await vi.advanceTimersByTimeAsync(PRINT_DELAY_MS);
  });

  it('cleans the iframe up rather than leaking one per export', async () => {
    await clickExportPdf();
    await vi.advanceTimersByTimeAsync(CLEANUP_DELAY_MS);

    expect(frames()).toHaveLength(0);
  });
});

describe('Export PDF click cycle — button state while in flight', () => {
  it('goes busy synchronously and keeps the menu open until it settles', () => {
    pdfOption().click();

    expect(pdfOption().disabled).toBe(true);
    expect(pdfOption().classList.contains('is-exporting')).toBe(true);
    expect(pdfOption().textContent).toBe(tt('components.exportGate.preparingPdf'));
    // The other formats close immediately; PDF must not, or the user loses
    // the only surface showing progress.
    expect(menu().classList.contains('hidden')).toBe(false);
  });

  it('restores the label and closes the menu once the report is printed', async () => {
    const label = pdfOption().textContent;

    await clickExportPdf();

    expect(pdfOption().disabled).toBe(false);
    expect(pdfOption().classList.contains('is-exporting')).toBe(false);
    expect(pdfOption().textContent).toBe(label);
    expect(menu().classList.contains('hidden')).toBe(true);
  });

  it('produces exactly one report for a double click', async () => {
    // Enforcement note: this invariant is carried by `button.disabled`, which
    // stops the second event from ever being dispatched. The additional
    // `if (button.disabled) return` re-entrancy guard inside
    // exportPdfWithFeedback is therefore UNREACHABLE through any DOM event
    // path — removing it does not turn this test red. It is defence in depth
    // for a future programmatic caller, not something these tests can cover.
    pdfOption().click();
    pdfOption().click();
    await vi.advanceTimersByTimeAsync(PRINT_DELAY_MS);

    expect(getData).toHaveBeenCalledTimes(1);
    expect(recorder.printed).toHaveLength(1);
  });
});

describe('Export PDF click cycle — failure surfaces', () => {
  it('surfaces a toast instead of a button that silently did nothing', async () => {
    recorder.failNext(new Error('print blocked'));

    await clickExportPdf();

    expect(toast()).not.toBeNull();
    expect(toast()!.textContent).toBe(tt('components.exportGate.pdfFailed'));
    expect(toast()!.getAttribute('role')).toBe('status');
    expect(recorder.printed).toHaveLength(0);
    // The user-facing toast says nothing useful for debugging; the cause has
    // to reach the console too.
    expect(warnSpy).toHaveBeenCalledWith('[export] PDF report failed:', expect.any(Error));
  });

  it('restores the button and closes the menu after a failure', async () => {
    const label = pdfOption().textContent;
    recorder.failNext(new Error('print blocked'));

    await clickExportPdf();

    expect(pdfOption().disabled).toBe(false);
    expect(pdfOption().classList.contains('is-exporting')).toBe(false);
    expect(pdfOption().textContent).toBe(label);
    expect(menu().classList.contains('hidden')).toBe(true);
  });

  it('does not leak the iframe when printing throws', async () => {
    recorder.failNext(new Error('print blocked'));

    await clickExportPdf();

    expect(frames()).toHaveLength(0);
  });

  it('leaves the export usable: a retry after a failure still prints', async () => {
    recorder.failNext(new Error('print blocked'));
    await clickExportPdf();

    trigger().click(); // reopen
    await clickExportPdf();

    expect(recorder.printed).toHaveLength(1);
    expect(recorder.printed[0]).toContain('Baseline headline');
  });
});
