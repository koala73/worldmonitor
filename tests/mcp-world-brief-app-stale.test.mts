// The World Brief MCP App card must SHOW that a brief is stale.
//
// Serving last-known-good (PR #7271) is only safe because the response is
// labelled — but the label lived in JSON fields no human ever sees. An MCP
// Apps host renders this tool through `_uiResourceUri`, and the card's footer
// showed provider, model and a raw timestamp while never reading `stale` or
// `ageMinutes` (`api/mcp/ui/world-brief-app.ts`). A two-hour-old brief was
// therefore presented identically to a fresh one — on the one surface where a
// person, not an agent, is doing the weighing (review, PR #7271).
//
// Drives the genuine emitted shell: the same HTML `resources/read` serves and
// the same postMessage handshake a host performs, per
// tests/mcp-market-radar-app-render.test.mts.

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { Window } from 'happy-dom';

import { WORLD_BRIEF_APP_HTML } from '../api/mcp/ui/world-brief-app';

function briefPayload(overrides: Record<string, unknown> = {}) {
  return {
    brief: 'Seeded grounded world brief.',
    summary: 'Seeded grounded world brief.',
    headlines: ['Corroborated headline'],
    topStories: [{ title: 'Corroborated headline', sourceCount: 9 }],
    provider: 'seeded-provider',
    model: 'seeded-model',
    generatedAt: new Date().toISOString(),
    stale: false,
    ageMinutes: 2,
    sources: [{
      title: 'Corroborated headline',
      source: 'Example Wire',
      url: 'https://example.com/story',
      publishedAt: '2026-08-10T00:00:00.000Z',
    }],
    ...overrides,
  };
}

async function render(payload: Record<string, unknown>) {
  const win: any = new Window({ url: 'https://worldmonitor.app/' });
  win.document.write(WORLD_BRIEF_APP_HTML);
  await win.happyDOM.waitUntilComplete();

  // happy-dom does not execute a <script> introduced by document.write, so run
  // the served script text itself — the real bridge, not a reimplementation.
  const script = win.document.querySelector('script');
  assert.ok(script && script.textContent.length > 0, 'app shell must ship an inline bridge script');
  win.eval(script.textContent);
  await win.happyDOM.waitUntilComplete();

  // The bridge captures `window.parent` in its own realm and drops any message
  // whose source is not that object, so the handshake needs the in-realm ref.
  const hostWindow = win.eval('window.parent');
  win.dispatchEvent(new win.MessageEvent('message', {
    data: {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } },
    },
    source: hostWindow,
  }));
  await win.happyDOM.waitUntilComplete();
  return win;
}

describe('api/mcp/ui/world-brief-app.ts — surfaces staleness to a human', () => {
  let freshWin: any;
  let staleWin: any;

  before(async () => {
    freshWin = await render(briefPayload());
    staleWin = await render(briefPayload({
      stale: true,
      ageMinutes: 137,
      generatedAt: new Date(Date.now() - 137 * 60_000).toISOString(),
    }));
  });

  after(async () => {
    await freshWin?.happyDOM?.close();
    await staleWin?.happyDOM?.close();
  });

  // Assertions target the note ELEMENT rather than `body.textContent`: the
  // shell inlines its <style> block, whose `.stale-note { … }` rule is itself
  // body text containing the word "stale", so a whole-document match would
  // report a banner that is not being shown.
  const note = (win: any) => win.document.getElementById('stale-note');

  it('renders the brief at all — harness guard', () => {
    // Without this the assertions below could pass vacuously over an empty DOM.
    assert.match(String(freshWin.document.getElementById('brief').textContent), /Seeded grounded world brief/);
    assert.match(String(staleWin.document.getElementById('brief').textContent), /Seeded grounded world brief/);
  });

  it('shows a stale notice, with the age, when the brief is stale', () => {
    const el = note(staleWin);
    assert.equal(el.style.display, 'block', 'the notice must actually be shown');
    const text = String(el.textContent);
    assert.match(text, /stale/i, 'a person must be able to see the brief is not current');
    // Humanised, not the raw minute count — "2h 17m old" reads at a glance
    // where "137" needs arithmetic.
    assert.match(text, /2h 17m/, `the age has to be shown, got ${text.slice(0, 120)}`);
  });

  it('shows no stale notice on a fresh brief', () => {
    // Positive control: a banner that is always present teaches nothing.
    const el = note(freshWin);
    assert.equal(el.style.display, 'none', 'a fresh brief must not be labelled stale');
    assert.equal(String(el.textContent).trim(), '', 'and must carry no leftover text');
  });

  it('renders a sub-hour age in minutes rather than 0h', () => {
    // The humaniser branches at 60 minutes; without this the minutes branch is
    // never exercised and could read "0h 12m".
    return render(briefPayload({ stale: true, ageMinutes: 12 })).then(async (win: any) => {
      assert.match(String(note(win).textContent), /12 minutes old/);
      await win.happyDOM.close();
    });
  });
});
