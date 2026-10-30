// OREF alerts used to send their own multi-line instruction prompt
// ("Translate each line ... Keep the ALERT/AREAS/DESC labels") as the text of
// a translate request. Translate now treats its text as data and translates it
// literally, so that prompt would come back translated, not followed. OREF
// sends each untranslated Hebrew string as plain text instead and keeps its
// static dictionary as the fallback.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const translateText = vi.fn<(text: string, lang: string) => Promise<string | null>>();

vi.mock('@/services/summarization', () => ({ translateText }));
vi.mock('@/services/oref-locations', () => ({
  translateLocation: (s: string) => (s === 'תל אביב - מרכז העיר' ? 'Tel Aviv - City Center' : s),
}));

const originalFetch = window.fetch;

const LLM_EN: Record<string, string> = {
  'היכנסו למרחב המוגן ושהו בו 10 דקות': 'Enter the protected space and stay there for 10 minutes',
  'כפר ורדים': 'Kfar Vradim',
};

function historyResponse(alerts: unknown[]): Response {
  return new Response(JSON.stringify({
    configured: true,
    history: [{ alerts, timestamp: '2026-10-27T10:00:00Z' }],
    historyCount24h: alerts.length,
    timestamp: '2026-10-27T10:00:00Z',
  }), { headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.resetModules();
  translateText.mockReset();
  translateText.mockImplementation(async (text) => LLM_EN[text] ?? null);
});

afterEach(() => {
  window.fetch = originalFetch;
});

it('translates each Hebrew string as plain text and parses the result per item', async () => {
  window.fetch = (async () => historyResponse([
    {
      id: 'a1', cat: '1', alertDate: '2026-10-27 10:00:00',
      title: 'ירי רקטות וטילים',
      data: ['תל אביב - מרכז העיר', 'כפר ורדים'],
      desc: 'היכנסו למרחב המוגן ושהו בו 10 דקות',
    },
    {
      id: 'a2', cat: '1', alertDate: '2026-10-27 10:00:05',
      title: 'ירי רקטות וטילים',
      data: ['כפר ורדים'],
      desc: 'היכנסו למרחב המוגן ושהו בו 10 דקות',
    },
  ])) as typeof fetch;

  const { fetchOrefHistory } = await import('@/services/oref-alerts');
  const result = await fetchOrefHistory();

  // Only strings the dictionary and location map cannot cover reach the LLM,
  // once each, as bare text: no labels, ids or instructions.
  const sent = translateText.mock.calls.map(([text, lang]) => [text, lang]);
  expect(sent.sort()).toEqual([
    ['כפר ורדים', 'en'],
    ['היכנסו למרחב המוגן ושהו בו 10 דקות', 'en'],
  ].sort());
  for (const [text] of sent) {
    expect(text).not.toMatch(/ALERT\[|AREAS\[|DESC\[|Translate/);
    expect(text).not.toContain('\n');
  }

  const [a1, a2] = result.history[0]!.alerts;
  expect(a1).toMatchObject({
    title: 'Rocket and missile fire',
    data: ['Tel Aviv - City Center', 'Kfar Vradim'],
    desc: 'Enter the protected space and stay there for 10 minutes',
  });
  expect(a2).toMatchObject({
    title: 'Rocket and missile fire',
    data: ['Kfar Vradim'],
    desc: 'Enter the protected space and stay there for 10 minutes',
  });
});

it('falls back to the static dictionary for a string the LLM cannot translate, and does not resend it', async () => {
  translateText.mockImplementation(async () => null);
  window.fetch = (async () => historyResponse([
    {
      id: 'b1', cat: '1', alertDate: '2026-10-27 11:00:00',
      title: 'ירי רקטות וטילים',
      data: ['כפר ורדים'],
      desc: 'היכנסו למרחב המוגן',
    },
  ])) as typeof fetch;

  const { fetchOrefHistory } = await import('@/services/oref-alerts');
  const first = await fetchOrefHistory();
  const alert = first.history[0]!.alerts[0]!;
  expect(alert.title).toBe('Rocket and missile fire');
  expect(alert.desc).toBe('Enter the protected space');
  expect(alert.data).toEqual(['כפר ורדים']);
  const callsAfterFirst = translateText.mock.calls.length;
  expect(callsAfterFirst).toBe(1);

  await fetchOrefHistory();
  expect(translateText.mock.calls.length).toBe(callsAfterFirst);
});

it('ignores an LLM answer that is still Hebrew', async () => {
  translateText.mockImplementation(async (text) => text);
  window.fetch = (async () => historyResponse([
    { id: 'c1', cat: '1', alertDate: '2026-10-27 12:00:00', title: 'ירי רקטות וטילים', data: ['כפר ורדים'], desc: '' },
  ])) as typeof fetch;

  const { fetchOrefHistory } = await import('@/services/oref-alerts');
  const result = await fetchOrefHistory();
  expect(result.history[0]!.alerts[0]!.data).toEqual(['כפר ורדים']);
  expect(result.history[0]!.alerts[0]!.title).toBe('Rocket and missile fire');
});

it('shows every finished string while an alert still has strings waiting for a later pass', async () => {
  // Nine unmapped areas: one pass sends eight, so the alert is not settled yet.
  const areas = Array.from({ length: 9 }, (_, i) => `יישוב ${'א'.repeat(i + 1)}`);
  translateText.mockImplementation(async (text) => `Place ${text.length}`);
  window.fetch = (async () => historyResponse([
    { id: 'd1', cat: '1', alertDate: '2026-10-27 13:00:00', title: 'ירי רקטות וטילים', data: areas, desc: '' },
  ])) as typeof fetch;

  const { fetchOrefHistory } = await import('@/services/oref-alerts');
  const result = await fetchOrefHistory();
  expect(translateText).toHaveBeenCalledTimes(8);
  const shown = result.history[0]!.alerts[0]!.data;
  expect(shown.filter((a) => a.startsWith('Place ')).length).toBe(8);
  expect(shown.filter((a) => /[֐-׿]/.test(a)).length).toBe(1);
});
