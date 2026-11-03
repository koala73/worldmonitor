/**
 * The dashboard "Embed this map" dialog.
 *
 * Two snippets, one dialog. The free iframe form is ungated on purpose — it is
 * a supported product surface, not a trial, and it must keep working for a
 * signed-out visitor. The keyed loader form appears only for an account that
 * can actually mint an embed key, and has to be legibly better than the free
 * one: all fourteen layers, ten minutes instead of hourly, AT THE CURRENT
 * VIEW. That last part is the easy thing to get wrong — public/embed.js only
 * learned to forward layers/center/zoom in this change, and without it the
 * paid snippet would render three default layers while the free snippet beside
 * it rendered the user's real map.
 *
 * EventHandlers pulls the whole dashboard import graph, so the two dialog
 * methods are extracted and transpiled against injected dependencies — the
 * same harness shape as unified-settings-account-handoff.test.mjs.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  buildEmbedIframeSnippet,
  buildEmbedLoaderSnippet,
  embedLayerIdsFromMapLayers,
  createBlankMapLayers,
  EMBED_KEY_PLACEHOLDER,
} from '@/embed/embed-url';
import { declareOverlay } from '@/utils/open-modal';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'src/app/event-handlers.ts'), 'utf8');

function extractMethod(signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  const braceStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1).replace(/^private\s+/, '');
    }
  }
  throw new Error(`unbalanced ${signature}`);
}

const js = ts.transpileModule(
  `class Harness { ${extractMethod('private openEmbedDialog(')}\n${extractMethod('private buildEmbedTier(')} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } },
).outputText;

let embedAccess = false;
let accountRole: 'free' | 'pro' = 'free';
const openSettings = vi.fn();

// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const Harness = new Function(
  'buildEmbedIframeSnippet',
  'buildEmbedLoaderSnippet',
  'embedLayerIdsFromMapLayers',
  'EMBED_KEY_PLACEHOLDER',
  'hasFeature',
  'hasEmbedAccessForAccount',
  'getAuthState',
  'getCurrentTheme',
  'SITE_VARIANT',
  'declareOverlay',
  `${js}\nreturn Harness;`,
)(
  buildEmbedIframeSnippet,
  buildEmbedLoaderSnippet,
  embedLayerIdsFromMapLayers,
  EMBED_KEY_PLACEHOLDER,
  (flag: string) => flag === 'embedAccess' && embedAccess,
  (role: 'free' | 'pro' | undefined) => role === 'pro' || embedAccess,
  () => ({ user: { role: accountRole } }),
  () => 'dark',
  'full',
  // The real one, so the dialog's reload contract is observable here rather
  // than stubbed away (a source-text harness must name every free identifier).
  declareOverlay,
);

const MAP_STATE = {
  layers: { ...createBlankMapLayers(), conflicts: true, protests: true, cables: true },
  zoom: 4.5,
};

function makeInstance() {
  const instance = new Harness();
  instance.ctx = {
    map: {
      getState: () => MAP_STATE,
      getCenter: () => ({ lat: 25.2048, lon: 55.2708 }),
    },
    unifiedSettings: { open: (tab: string) => openSettings(tab) },
  };
  // about:blank keeps happy-dom from actually loading the preview iframe.
  // Only the free snippet's SHAPE is under test here; what the real
  // getEmbedUrl() builds is covered by tests/embed-url.test.mts.
  instance.getEmbedUrl = () => 'about:blank';
  instance.closeEmbedDialog = () => {
    document.getElementById('embedModalOverlay')?.remove();
  };
  instance.copyToClipboard = vi.fn(async () => {});
  instance.boundEmbedModalKeydownHandler = null;
  return instance;
}

const tiers = () => Array.from(document.querySelectorAll('.embed-modal-tier'));
const snippets = () =>
  Array.from(document.querySelectorAll<HTMLTextAreaElement>('.embed-snippet-textarea'))
    .map((el) => el.value);

beforeEach(() => {
  document.body.replaceChildren();
  embedAccess = false;
  accountRole = 'free';
  openSettings.mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('embed dialog tiers', () => {
  it('offers only the keyless iframe snippet without embedAccess', () => {
    makeInstance().openEmbedDialog();

    expect(tiers()).toHaveLength(1);
    const [free] = snippets();
    expect(free).toContain('<iframe');
    expect(free).not.toContain('embed.js');
    expect(free).not.toContain(EMBED_KEY_PLACEHOLDER);
    expect(document.querySelector('.embed-manage-keys-btn')).toBeNull();
  });

  it('keeps the free snippet alongside the keyed one for a paid account', () => {
    embedAccess = true;
    makeInstance().openEmbedDialog();

    const [free, keyed] = snippets();
    expect(tiers()).toHaveLength(2);
    expect(free).toContain('<iframe');
    expect(keyed).toContain(`src="${window.location.origin}/embed.js"`);
    expect(keyed).toContain(`data-key="${EMBED_KEY_PLACEHOLDER}"`);
  });

  it('offers the keyed snippet for a verified Clerk PRO role before entitlement hydration', () => {
    accountRole = 'pro';
    makeInstance().openEmbedDialog();

    expect(tiers()).toHaveLength(2);
    expect(snippets()[1]).toContain(`data-key="${EMBED_KEY_PLACEHOLDER}"`);
  });

  it('carries the current map view into the keyed snippet', () => {
    // Without the data-* passthrough the keyed embed would render the three
    // default layers — strictly worse than the free snippet beside it.
    embedAccess = true;
    makeInstance().openEmbedDialog();

    const keyed = snippets()[1];
    expect(keyed).toContain('data-layers="conflicts,protests,cables"');
    expect(keyed).toContain('data-center="25.205,55.271"');
    expect(keyed).toContain('data-zoom="4.5"');
    expect(keyed).toContain('data-variant="full"');
  });

  it('spells out what each tier gives, in the dialog rather than the docs', () => {
    embedAccess = true;
    makeInstance().openEmbedDialog();

    const [freeText, keyedText] = tiers().map((t) => t.textContent ?? '');
    expect(freeText).toContain('hourly');
    expect(freeText).toContain('signed in or not');
    expect(keyedText).toContain('fourteen layers');
    expect(keyedText).toContain('10 minutes');
    expect(keyedText).toContain('meant to sit in your page HTML');
  });

  it('routes a paid account with no key yet to Settings -> Embeds', () => {
    embedAccess = true;
    makeInstance().openEmbedDialog();

    document.querySelector<HTMLButtonElement>('.embed-manage-keys-btn')!.click();

    expect(openSettings).toHaveBeenCalledWith('embeds');
    // Two stacked overlays is the dead end this avoids.
    expect(document.getElementById('embedModalOverlay')).toBeNull();
  });

  it('copies the snippet belonging to the button that was clicked', async () => {
    embedAccess = true;
    const instance = makeInstance();
    instance.openEmbedDialog();

    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.embed-copy-btn'));
    expect(buttons).toHaveLength(2);
    buttons[1]!.click();
    await vi.waitFor(() => expect(instance.copyToClipboard).toHaveBeenCalled());

    expect(instance.copyToClipboard).toHaveBeenCalledWith(snippets()[1]);
  });
});
