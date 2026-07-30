import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modalSrc = readFileSync(resolve(root, 'src/components/SearchModal.ts'), 'utf8');
const stylesSrc = readFileSync(resolve(root, 'src/styles/main.css'), 'utf8');

function extractMethod(signature: string): string {
  const start = modalSrc.indexOf(signature);
  assert.ok(start >= 0, `SearchModal must contain ${signature}`);
  const braceStart = modalSrc.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < modalSrc.length; i++) {
    if (modalSrc[i] === '{') depth++;
    if (modalSrc[i] === '}' && --depth === 0) {
      return modalSrc.slice(start, i + 1).replace(/^(public|private)\s+/, '');
    }
  }
  throw new Error(`Could not find the end of ${signature}`);
}

// SearchModal cannot be imported under node:test because its alias graph reads
// Vite-only globals. Compile its actual lifecycle methods into a minimal DOM
// harness instead, so this covers observable scheduling and cancellation rather
// than the formatting of its source.
const harnessSource = `
  class SearchModalHarness {
    constructor() {
      this.closeTimeoutId = null;
      this.mobileInitialPopulationGeneration = 0;
      this.debouncedSearch = { cancel() {} };
      this.viewportHandler = null;
      this.sources = [];
      this.overlay = null;
      this.input = null;
      this.resultsList = null;
      this.chipsContainer = null;
      this.results = [];
      this.commandResults = [];
      this.selectedIndex = 0;
      this.currentFlightCallsign = null;
      this.flightSearchFired = false;
      this.showingAllCommands = false;
      this.lastSearchedQuery = '';
      this.isMobile = true;
      this.createModalCalls = 0;
      this.focusCalls = 0;
      this.recentOrEmptyCalls = 0;
      this.chipRenderCalls = 0;
    }

    createModal() {
      this.createModalCalls++;
      this.overlay = {
        classList: { remove() {} },
        remove() {},
      };
      this.input = { value: '', focus: () => { this.focusCalls++; } };
      this.resultsList = {};
      this.chipsContainer = {};
    }

    showRecentOrEmpty() { this.recentOrEmptyCalls++; }
    renderChips() { this.chipRenderCalls++; }

    ${extractMethod('public open(): void {')}
    ${extractMethod('public close(): void {')}
    ${extractMethod('public refreshSearch(): void {')}
    ${extractMethod('private scheduleMobileReveal(overlay: HTMLElement): void {')}
    ${extractMethod('private scheduleMobileInitialPopulation(): void {')}
    ${extractMethod('private handleSearch(): void {')}
  }

  return SearchModalHarness;
`;
const harnessJs = ts.transpileModule(harnessSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
}).outputText;
interface SearchModalHarness {
  open(): void;
  close(): void;
  refreshSearch(): void;
  input: { value: string };
  createModalCalls: number;
  focusCalls: number;
  recentOrEmptyCalls: number;
  chipRenderCalls: number;
}
const Harness = new Function('isMobileDevice', harnessJs)(() => true) as new () => SearchModalHarness;

function withAnimationFrames(run: (frames: FrameRequestCallback[]) => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const frames: FrameRequestCallback[] = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
  });
  try {
    run(frames);
  } finally {
    if (original) Object.defineProperty(globalThis, 'requestAnimationFrame', original);
    else delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  }
}

function runNextFrame(frames: FrameRequestCallback[]): void {
  const frame = frames.shift();
  assert.ok(frame, 'expected a scheduled animation frame');
  frame(0);
}

test('mobile search renders only its shell in the tap task, then populates after the reveal frame (#5158)', () => {
  withAnimationFrames((frames) => {
    const modal = new Harness();
    modal.open();

    assert.equal(modal.createModalCalls, 1);
    assert.equal(modal.focusCalls, 1);
    assert.equal(modal.recentOrEmptyCalls, 0);
    assert.equal(modal.chipRenderCalls, 0);

    runNextFrame(frames);
    assert.equal(modal.recentOrEmptyCalls, 0, 'the reveal frame must stay free of list work');
    runNextFrame(frames);
    assert.equal(modal.recentOrEmptyCalls, 1);
    assert.equal(modal.chipRenderCalls, 1);
  });
});

test('a typed query or a reopened sheet invalidates stale initial mobile population (#5158)', () => {
  withAnimationFrames((frames) => {
    const modal = new Harness();
    modal.open();
    runNextFrame(frames);
    modal.input.value = 'iran';
    runNextFrame(frames);
    assert.equal(modal.recentOrEmptyCalls, 0, 'initial empty state must not overwrite an early query');
    assert.equal(modal.chipRenderCalls, 0);

    modal.close();
    modal.open();
    modal.close();
    modal.open();

    while (frames.length > 0) runNextFrame(frames);
    assert.equal(modal.recentOrEmptyCalls, 1, 'only the reopened sheet may populate');
    assert.equal(modal.chipRenderCalls, 1);
  });
});

test('a direct refresh before the inner reveal frame owns mobile search results (#5158)', () => {
  withAnimationFrames((frames) => {
    const modal = new Harness();
    modal.open();
    runNextFrame(frames);

    modal.refreshSearch();
    assert.equal(modal.recentOrEmptyCalls, 1, 'the direct refresh renders immediately');
    assert.equal(modal.chipRenderCalls, 1);

    runNextFrame(frames);
    assert.equal(modal.recentOrEmptyCalls, 1, 'stale initial population must not overwrite refreshed results');
    assert.equal(modal.chipRenderCalls, 1);
  });
});

test('a close before the queued reveal frame cannot reopen the outgoing mobile sheet (#5158)', () => {
  withAnimationFrames((frames) => {
    const modal = new Harness() as unknown as SearchModalHarness & {
      overlay: HTMLElement | null;
      scheduleMobileReveal(overlay: HTMLElement): void;
    };
    const classOperations: string[] = [];
    const overlay = {
      classList: {
        add: (name: string) => classOperations.push(`add:${name}`),
        remove: (name: string) => classOperations.push(`remove:${name}`),
      },
      remove() {},
    } as unknown as HTMLElement;
    modal.overlay = overlay;

    modal.scheduleMobileReveal(overlay);
    modal.close();
    runNextFrame(frames);

    assert.deepEqual(classOperations, ['remove:open']);
    modal.open(); // Clears close's removal timer before this test returns.
  });
});

test('mobile search CSS never hides the sheet or input with content-visibility (#5158)', () => {
  assert.doesNotMatch(
    stylesSrc,
    /\.search-overlay\.search-mobile[^{}]*(?:\.search-sheet|\.search-input)[^{}]*\{[^}]*content-visibility\s*:\s*hidden/i,
  );
});
