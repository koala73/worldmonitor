import { afterEach, describe, expect, it, vi } from 'vitest';

// Runs the real welcome entry (`pro-test/src/welcome-main.tsx`) rather than the
// `prepareWelcomeRoot` helper alone, so the test fails if the entry ever reads
// `#root.dataset` before checking that the node exists (WORLDMONITOR-16Y).

const react = vi.hoisted(() => ({
  render: vi.fn(),
  createRoot: vi.fn(),
  hydrateRoot: vi.fn(),
}));
const i18n = vi.hoisted(() => ({ settled: undefined as Promise<unknown> | undefined }));

vi.mock('react-dom/client', () => ({
  createRoot: react.createRoot.mockImplementation(() => ({ render: react.render })),
  hydrateRoot: react.hydrateRoot,
}));
vi.mock('../../pro-test/src/WelcomeApp.tsx', () => ({ default: () => null }));
vi.mock('../../pro-test/src/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../../pro-test/src/debugbear-rum', () => ({ initDebugBearRum: vi.fn() }));
vi.mock('../../pro-test/src/index.css', () => ({}));
vi.mock('../../pro-test/src/i18n', () => ({
  effectiveWelcomeContentLanguage: () => 'en',
  // Expose the promise the entry chains its mount onto, so a throw inside the
  // mount callback surfaces here as a rejection instead of an unhandled one.
  initI18n: () => ({
    then(onReady: () => void) {
      i18n.settled = Promise.resolve().then(onReady);
      return i18n.settled;
    },
  }),
}));

// A variable specifier keeps tsconfig.dom-tests.json (no `jsx` setting) from
// type-checking pro-test's TSX graph; Vitest still transforms and runs it.
const WELCOME_ENTRY = '../../pro-test/src/welcome-main.tsx';

async function runWelcomeEntry(): Promise<void> {
  vi.resetModules();
  i18n.settled = undefined;
  await import(/* @vite-ignore */ WELCOME_ENTRY);
  expect(i18n.settled, 'the entry chains its mount onto initI18n').toBeDefined();
  await i18n.settled;
}

afterEach(() => {
  document.body.replaceChildren();
  react.render.mockClear();
  react.createRoot.mockClear();
  react.hydrateRoot.mockClear();
});

describe('welcome entry bootstrap', () => {
  it('does not throw or mount when the page has no #root', async () => {
    await expect(runWelcomeEntry()).resolves.toBeUndefined();
    expect(react.createRoot).not.toHaveBeenCalled();
    expect(react.hydrateRoot).not.toHaveBeenCalled();
  });

  it('renders into #root when it is present', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);

    await runWelcomeEntry();

    expect(react.createRoot).toHaveBeenCalledWith(root);
    expect(react.render).toHaveBeenCalledOnce();
  });
});
