/**
 * Trip assessment export (#10451, phase 2): the request the dialog builds, how
 * the server's answers are told to the person, and the dialog's behaviour.
 * The plan gate itself is the server's (tests/travel-risk-export-route.test.mts);
 * what is pinned here is that the browser never decides it, and never keeps
 * what was typed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { openTripAssessment } from '@/components/TripAssessmentDialog';
import { openTripAssessmentForScope } from '@/components/focus-ui';
import {
  buildTripRequest,
  draftFromHandoff,
  parseCities,
  requestTripAssessment,
  validateTripDraft,
  type TripDraft,
} from '@/services/travel-risk-export';
import { reportHandoffFromScope } from '../../shared/report-handoff';
import type { TabScope } from '../../shared/tab-scope';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

const nameOf = (code: string) => ({ TH: 'Thailand', VN: 'Vietnam', ID: 'Indonesia', MY: 'Malaysia' } as Record<string, string>)[code] ?? code;
const SEA: TabScope = { countries: ['TH', 'VN', 'ID'], neighbours: true, start: '2026-12-01', end: '2026-12-12' };

function draft(overrides: Partial<TripDraft> = {}): TripDraft {
  return {
    countries: [
      { code: 'TH', cities: 'Bangkok, Chiang Mai', arrive: '2026-12-01', depart: '2026-12-05' },
      { code: 'VN', cities: '', arrive: '', depart: '' },
    ],
    dateFrom: '2026-12-01',
    dateTo: '2026-12-12',
    taskLabel: '  Regional site visits ',
    ...overrides,
  };
}

const okResponse = (text = '# Travel risk assessment draft\n') => new Response(text, { status: 200 });
const fail = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('draft shaping', () => {
  it('starts from the focus: its countries in order and its window', () => {
    const handoff = reportHandoffFromScope(SEA);
    expect(draftFromHandoff(handoff)).toEqual({
      countries: [
        { code: 'TH', cities: '', arrive: '', depart: '' },
        { code: 'VN', cities: '', arrive: '', depart: '' },
        { code: 'ID', cities: '', arrive: '', depart: '' },
      ],
      dateFrom: '2026-12-01',
      dateTo: '2026-12-12',
      taskLabel: '',
    });
  });

  it('splits cities on commas, semicolons and lines, drops blanks and repeats', () => {
    expect(parseCities(' Bangkok, chiang mai;Phuket\nbangkok ,, ')).toEqual(['Bangkok', 'chiang mai', 'Phuket']);
    expect(parseCities('')).toEqual([]);
  });

  it('builds the tool-shaped request with only what was filled in', () => {
    expect(buildTripRequest(draft(), 'html')).toEqual({
      format: 'html',
      countries: [
        { country_code: 'TH', cities: ['Bangkok', 'Chiang Mai'], arrive: '2026-12-01', depart: '2026-12-05' },
        { country_code: 'VN' },
      ],
      date_from: '2026-12-01',
      date_to: '2026-12-12',
      task_label: 'Regional site visits',
    });
    expect(buildTripRequest(draft({ dateFrom: '', dateTo: '', taskLabel: '   ' }), 'markdown')).not.toHaveProperty('date_from');
    expect(buildTripRequest(draft({ taskLabel: '' }), 'markdown')).not.toHaveProperty('task_label');
  });

  it('checks what a form makes easy to get wrong, and names the country', () => {
    expect(validateTripDraft(draft(), nameOf)).toBeNull();
    expect(validateTripDraft(draft({ countries: [] }), nameOf)?.key).toBe('tripAssessment.errNoCountries');
    expect(validateTripDraft(draft({ dateFrom: '2026-12-10', dateTo: '2026-12-01' }), nameOf)?.key).toBe('tripAssessment.errWindow');
    const reversed = draft();
    reversed.countries[0]!.arrive = '2026-12-06';
    expect(validateTripDraft(reversed, nameOf)).toEqual({ key: 'tripAssessment.errCountryDates', params: { name: 'Thailand' } });
    const outside = draft();
    outside.countries[1]!.arrive = '2027-01-01';
    expect(validateTripDraft(outside, nameOf)).toEqual({ key: 'tripAssessment.errOutsideWindow', params: { name: 'Vietnam' } });
    const many = draft();
    many.countries[0]!.cities = 'a,b,c,d,e,f';
    expect(validateTripDraft(many, nameOf)).toEqual({ key: 'tripAssessment.errCities', params: { name: 'Thailand', max: 5 } });
    const seven = draft({ countries: Array.from({ length: 7 }, (_, i) => ({ code: `C${i}`, cities: '', arrive: '', depart: '' })) });
    expect(validateTripDraft(seven, nameOf)?.key).toBe('tripAssessment.errTooMany');
  });
});

describe('requestTripAssessment', () => {
  it('posts the request with the session token forced on, and returns a named file', async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse('BODY'));
    const result = await requestTripAssessment(draft(), 'markdown', { fetcher, now: () => Date.parse('2026-11-10T12:00:00Z') });
    expect(result).toEqual({ ok: true, content: 'BODY', filename: 'travel-risk-assessment-2026-11-10.md', mimeType: 'text/markdown;charset=utf-8' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/travel-risk-assessment');
    expect(init.method).toBe('POST');
    expect(init.forcePremium).toBe(true);
    expect(JSON.parse(init.body)).toMatchObject({ format: 'markdown', countries: [{ country_code: 'TH' }, { country_code: 'VN' }] });
  });

  it('names an HTML file for Word', async () => {
    const result = await requestTripAssessment(draft(), 'html', { fetcher: async () => okResponse('<html></html>'), now: () => Date.parse('2026-11-10T12:00:00Z') });
    expect(result).toMatchObject({ ok: true, filename: 'travel-risk-assessment-2026-11-10.html', mimeType: 'text/html;charset=utf-8' });
  });

  it('tells each server answer apart', async () => {
    const reason = async (status: number, body?: unknown) =>
      (await requestTripAssessment(draft(), 'markdown', { fetcher: async () => fail(status, body) }) as { reason: string }).reason;
    expect(await reason(401)).toBe('auth');
    expect(await reason(403, { error: 'UPGRADE_REQUIRED' })).toBe('upgrade');
    expect(await reason(400, { error: 'INVALID_ARGUMENTS', violations: [] })).toBe('invalid');
    expect(await reason(413)).toBe('invalid');
    expect(await reason(429)).toBe('busy');
    expect(await reason(503)).toBe('unavailable');
    expect(await reason(500)).toBe('error');
  });

  it('carries the server violations and drops anything that is not one', async () => {
    const result = await requestTripAssessment(draft(), 'markdown', {
      fetcher: async () => fail(400, { violations: [{ field: 'countries.0.arrive', description: 'Must be a date.' }, { nope: 1 }, 'x'] }),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid', violations: [{ field: 'countries.0.arrive', description: 'Must be a date.' }] });
  });

  it('reports a download that breaks after the headers as an error, not an unhandled rejection', async () => {
    const broken = new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('connection reset')); } }), { status: 200 });
    const result = await requestTripAssessment(draft(), 'markdown', { fetcher: async () => broken });
    expect(result).toEqual({ ok: false, reason: 'error', violations: [] });
  });

  it('reports a network failure as a generic error, not a plan verdict', async () => {
    const result = await requestTripAssessment(draft(), 'markdown', { fetcher: async () => { throw new TypeError('offline'); } });
    expect(result).toEqual({ ok: false, reason: 'error', violations: [] });
  });
});

describe('TripAssessmentDialog', () => {
  const q = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
  const rows = () => [...document.querySelectorAll<HTMLElement>('.trip-assessment-row')].map((row) => row.dataset.code);
  const click = (selector: string) => q<HTMLButtonElement>(selector).click();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const status = () => q('.trip-assessment-status').textContent;
  const error = () => q('.focus-editor-error');

  beforeEach(() => { document.body.replaceChildren(); });
  afterEach(() => {
    // Close through the dialog so its focus trap is released; removing the DOM
    // alone leaves a capture-phase keydown listener on the document.
    document.querySelector<HTMLButtonElement>('.trip-assessment .modal-close')?.click();
    document.body.replaceChildren();
  });

  function open(extra: Partial<Parameters<typeof openTripAssessment>[0]> = {}) {
    return openTripAssessment({ initial: draftFromHandoff(reportHandoffFromScope(SEA)), ...extra });
  }

  it('opens with the focus countries in order, the window, and no field for a person', () => {
    open();
    expect(rows()).toEqual(['TH', 'VN', 'ID']);
    expect(q<HTMLInputElement>('.trip-assessment-from').value).toBe('2026-12-01');
    expect(q<HTMLInputElement>('.trip-assessment-to').value).toBe('2026-12-12');
    expect(q('.trip-assessment-row-name').textContent).toBe('1. Thailand');
    // Countries, cities and dates only: the inputs are a label, two dates, a
    // search, and per country cities and two dates. Nothing asks for a name.
    const labels = [...document.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels.join('|')).not.toMatch(/name of|traveller|hotel|address|passport|phone/i);
    expect(q('.focus-editor-hint').textContent).toMatch(/Do not enter traveller names, hotels or street addresses\. Nothing you enter is stored\./);
  });

  it('says which focus countries did not fit in a trip', () => {
    const scope: TabScope = { countries: ['TH', 'VN', 'ID', 'MY', 'SG', 'PH', 'KH', 'LA'], neighbours: true };
    const handoff = reportHandoffFromScope(scope);
    open({ initial: draftFromHandoff(handoff), omitted: handoff.omitted });
    expect(rows()).toHaveLength(6);
    expect(document.body.textContent).toMatch(/Left out because a trip covers at most 6 countries: Cambodia, Laos\./);
    expect(q<HTMLInputElement>('.trip-assessment-search').disabled).toBe(true);
    expect(q('.focus-editor-limit').hasAttribute('hidden')).toBe(false);
  });

  it('adds a country from the search, up to the limit', () => {
    open({ initial: { ...draft(), countries: draft().countries } });
    const search = q<HTMLInputElement>('.trip-assessment-search');
    search.value = 'malay';
    search.dispatchEvent(new Event('input'));
    click('.focus-editor-result[data-code="MY"]');
    expect(rows()).toEqual(['TH', 'VN', 'MY']);
    expect(q('.focus-editor-count').textContent).toBe('3 of 6');
  });

  it('reorders with the buttons and keeps focus on the moved country', () => {
    open();
    click('[data-code="ID"] [data-action="up"]');
    expect(rows()).toEqual(['TH', 'ID', 'VN']);
    expect((document.activeElement as HTMLElement).dataset.action).toBe('up');
    expect((document.activeElement?.closest('li') as HTMLElement).dataset.code).toBe('ID');
    expect(q<HTMLButtonElement>('[data-code="TH"] [data-action="up"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-code="VN"] [data-action="down"]').disabled).toBe(true);
  });

  it('removes a country and keeps focus inside the dialog', () => {
    open();
    click('[data-code="VN"] [data-action="remove"]');
    expect(rows()).toEqual(['TH', 'ID']);
    expect(document.activeElement && q('.trip-assessment').contains(document.activeElement)).toBe(true);
  });

  it('downloads Markdown for the trip as typed, in travel order', async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse('MD'));
    const deliver = vi.fn().mockResolvedValue({ state: 'attempted' });
    open({ fetcher, deliver });
    q<HTMLInputElement>('.trip-assessment-label').value = 'Site visit';
    q<HTMLInputElement>('.trip-assessment-label').dispatchEvent(new Event('input'));
    const cities = q<HTMLInputElement>('[data-code="TH"] .trip-assessment-cities');
    cities.value = 'Bangkok';
    cities.dispatchEvent(new Event('input'));
    click('[data-code="ID"] [data-action="up"]');
    click('.trip-assessment-markdown');
    await tick(); await tick();
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body.format).toBe('markdown');
    expect(body.countries.map((c: { country_code: string }) => c.country_code)).toEqual(['TH', 'ID', 'VN']);
    expect(body.countries[0].cities).toEqual(['Bangkok']);
    expect(body.task_label).toBe('Site visit');
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]![0]).toMatchObject({ content: 'MD', mimeType: 'text/markdown;charset=utf-8' });
    expect(status()).toMatch(/^Downloaded travel-risk-assessment-\d{4}-\d{2}-\d{2}\.md\./);
  });

  it('downloads HTML for Word, and prints the same HTML', async () => {
    const fetcher = vi.fn().mockResolvedValue(okResponse('<html>x</html>'));
    const deliver = vi.fn().mockResolvedValue({ state: 'attempted' });
    const print = vi.fn();
    open({ fetcher, deliver, print });
    click('.trip-assessment-word');
    await tick(); await tick();
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).format).toBe('html');
    expect(deliver.mock.calls[0]![0]).toMatchObject({ mimeType: 'text/html;charset=utf-8' });
    fetcher.mockResolvedValue(okResponse('<html>y</html>'));
    click('.trip-assessment-print');
    await tick(); await tick();
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).format).toBe('html');
    expect(print).toHaveBeenCalledWith('<html>y</html>');
    expect(deliver).toHaveBeenCalledOnce();
    expect(status()).toMatch(/Print dialog opened/);
  });

  it('refuses a malformed trip before asking the server', async () => {
    const fetcher = vi.fn();
    open({ fetcher });
    q<HTMLInputElement>('.trip-assessment-to').value = '2026-11-01';
    q<HTMLInputElement>('.trip-assessment-to').dispatchEvent(new Event('input'));
    click('.trip-assessment-markdown');
    await tick();
    expect(fetcher).not.toHaveBeenCalled();
    expect(error().textContent).toBe('The trip must end on or after the day it starts.');
  });

  it('tells an account without the plan to upgrade, in words, with no file', async () => {
    const deliver = vi.fn();
    open({ fetcher: async () => fail(403, { error: 'UPGRADE_REQUIRED' }), deliver });
    click('.trip-assessment-markdown');
    await tick(); await tick();
    expect(error().textContent).toBe('The trip assessment is included in the Pro Business, API Business and Enterprise plans.');
    expect(deliver).not.toHaveBeenCalled();
    expect(q<HTMLButtonElement>('.trip-assessment-markdown').disabled).toBe(false);
  });

  it('shows the server violations when the trip is rejected', async () => {
    open({ fetcher: async () => fail(400, { violations: [{ field: 'countries.1.arrive', description: 'Countries are listed in travel order.' }] }) });
    click('.trip-assessment-word');
    await tick(); await tick();
    expect(error().textContent).toBe('The draft could not be built from this trip:');
    expect(q('.trip-assessment-violations').textContent).toContain('Vietnam · Arrive: Countries are listed in travel order.');
    expect(q('.trip-assessment-violations').textContent).not.toContain('countries.1');
  });

  it('names the form field, not the request path, for each kind of violation', async () => {
    open({
      fetcher: async () => fail(400, { violations: [
        { field: 'countries.2.depart', description: 'Must be on or after arrive.' },
        { field: 'date_to', description: 'Must be on or after date_from.' },
        { field: 'task_label', description: 'Use one line of plain text.' },
        { field: 'countries.0.cities.1', description: 'Use a plain city name.' },
        { field: 'traveller_name', description: 'Unknown argument.' },
      ] }),
    });
    click('.trip-assessment-markdown');
    await tick(); await tick();
    const lines = [...document.querySelectorAll('.trip-assessment-violations li')].map((li) => li.textContent);
    expect(lines).toEqual([
      'Indonesia · Depart: Must be on or after arrive.',
      'Trip ends: Must be on or after date_from.',
      'Task label (optional): Use one line of plain text.',
      'Thailand: Use a plain city name.',
      'traveller_name: Unknown argument.',
    ]);
  });

  it('clears "Building" and says so when the file breaks off mid-download', async () => {
    const broken = () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('reset')); } }), { status: 200 });
    open({ fetcher: async () => broken() });
    click('.trip-assessment-markdown');
    await tick(); await tick(); await tick();
    expect(error().textContent).toBe('The draft could not be built. Try again.');
    expect(status()).toBe('');
    expect(q<HTMLButtonElement>('.trip-assessment-markdown').disabled).toBe(false);
  });

  it('locks the form while a draft is being built and unlocks it, with focus back on the button, after', async () => {
    let release!: (r: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    open({ fetcher, deliver: vi.fn().mockResolvedValue({ state: 'attempted' }) });
    const word = q<HTMLButtonElement>('.trip-assessment-word');
    word.focus();
    word.click();
    const editable = () => [...document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      '.trip-assessment-label, .trip-assessment-from, .trip-assessment-to, .trip-assessment-search, .trip-assessment-input, .trip-assessment-row-btn',
    )];
    expect(editable().length).toBeGreaterThan(10);
    expect(editable().every((control) => control.disabled)).toBe(true);
    // Nothing offered to type into or reorder can change the trip mid-request.
    expect(document.querySelectorAll('.focus-editor-result')).toHaveLength(0);
    release(okResponse('x'));
    await tick(); await tick(); await tick();
    expect(q<HTMLInputElement>('.trip-assessment-label').disabled).toBe(false);
    expect(q<HTMLButtonElement>('[data-code="TH"] [data-action="up"]').disabled).toBe(true); // first row: nothing earlier
    expect(q<HTMLButtonElement>('[data-code="VN"] [data-action="up"]').disabled).toBe(false);
    expect(q<HTMLInputElement>('[data-code="VN"] .trip-assessment-cities').disabled).toBe(false);
    expect(document.activeElement).toBe(q('.trip-assessment-word'));
  });

  it('keeps the country search locked after a draft when the trip is full', async () => {
    const six = ['TH', 'VN', 'ID', 'MY', 'SG', 'PH'];
    const handoff = reportHandoffFromScope({ countries: six, neighbours: false });
    openTripAssessment({ initial: draftFromHandoff(handoff), fetcher: async () => okResponse('x'), deliver: async () => ({ state: 'attempted' }) });
    click('.trip-assessment-markdown');
    await tick(); await tick(); await tick();
    expect(q<HTMLInputElement>('.trip-assessment-search').disabled).toBe(true);
    expect(q<HTMLInputElement>('.trip-assessment-label').disabled).toBe(false);
  });

  it('says so when the download itself throws, and lets the person try again', async () => {
    open({ fetcher: async () => okResponse('x'), deliver: async () => { throw new DOMException('blocked', 'SecurityError'); } });
    click('.trip-assessment-markdown');
    await tick(); await tick(); await tick();
    expect(error().textContent).toMatch(/Use Print or save as PDF instead/);
    expect(status()).toBe('');
    expect(q<HTMLButtonElement>('.trip-assessment-markdown').disabled).toBe(false);
  });

  it('says so when printing throws', async () => {
    open({ fetcher: async () => okResponse('<html></html>'), print: () => { throw new Error('no frame'); } });
    click('.trip-assessment-print');
    await tick(); await tick(); await tick();
    expect(error().textContent).toBe('The draft could not be built. Try again.');
    expect(status()).toBe('');
    expect(q<HTMLButtonElement>('.trip-assessment-print').disabled).toBe(false);
  });

  it('says when the data is unavailable and when the browser cannot save the file', async () => {
    open({ fetcher: async () => fail(503) });
    click('.trip-assessment-markdown');
    await tick(); await tick();
    expect(error().textContent).toMatch(/unavailable right now/);
    document.body.replaceChildren();
    open({ fetcher: async () => okResponse('x'), deliver: async () => ({ state: 'unsupported' }) });
    click('.trip-assessment-markdown');
    await tick(); await tick();
    expect(error().textContent).toMatch(/Use Print or save as PDF instead/);
    expect(status()).toBe('');
  });

  it('ignores a second press while a draft is being built', async () => {
    let release!: (r: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    open({ fetcher, deliver: vi.fn().mockResolvedValue({ state: 'attempted' }) });
    click('.trip-assessment-markdown');
    expect(q<HTMLButtonElement>('.trip-assessment-word').disabled).toBe(true);
    q<HTMLButtonElement>('.trip-assessment-word').click();
    expect(fetcher).toHaveBeenCalledOnce();
    release(okResponse('x'));
    await tick(); await tick();
    expect(q<HTMLButtonElement>('.trip-assessment-word').disabled).toBe(false);
  });

  it('closes on Escape, aborts a draft in flight and does not deliver afterwards', async () => {
    let signal: AbortSignal | undefined;
    let release!: (r: Response) => void;
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve) => { signal = init.signal as AbortSignal; release = resolve; }));
    const deliver = vi.fn();
    const onClose = vi.fn();
    open({ fetcher, deliver, onClose });
    click('.trip-assessment-markdown');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.trip-assessment')).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    release(okResponse('late'));
    await tick(); await tick();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('offers the AI-assistant request only when given a way to copy it', () => {
    open();
    expect(document.querySelector('.trip-assessment-copy')).toBeNull();
    document.body.replaceChildren();
    const onCopyRequest = vi.fn();
    open({ onCopyRequest });
    click('.trip-assessment-copy');
    expect(onCopyRequest).toHaveBeenCalledOnce();
    expect(onCopyRequest.mock.calls[0]![0].countries.map((c: { code: string }) => c.code)).toEqual(['TH', 'VN', 'ID']);
  });
});

describe('opening from a focus', () => {
  const rows = () => [...document.querySelectorAll<HTMLElement>('.trip-assessment-row')].map((row) => row.dataset.code);
  beforeEach(() => { document.body.replaceChildren(); });
  afterEach(() => {
    document.querySelector<HTMLButtonElement>('.trip-assessment .modal-close')?.click();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('opens the dialog prefilled from the focus, and says what did not fit', async () => {
    await openTripAssessmentForScope({ countries: ['TH', 'VN', 'ID', 'MY', 'SG', 'PH', 'KH', 'LA'], neighbours: true, start: '2026-12-01', end: '2026-12-12' });
    expect(rows()).toEqual(['TH', 'VN', 'ID', 'MY', 'SG', 'PH']);
    expect(document.querySelector<HTMLInputElement>('.trip-assessment-from')!.value).toBe('2026-12-01');
    expect(document.body.textContent).toContain('Cambodia, Laos');
  });

  it('does not list a country as left out once the analyst has swapped it in', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await openTripAssessmentForScope({ countries: ['TH', 'VN', 'ID', 'MY', 'SG', 'PH', 'KH', 'LA'], neighbours: true });
    document.querySelector<HTMLButtonElement>('[data-code="PH"] [data-action="remove"]')!.click();
    const search = document.querySelector<HTMLInputElement>('.trip-assessment-search')!;
    search.value = 'cambodia';
    search.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.focus-editor-result[data-code="KH"]')!.click();
    document.querySelector<HTMLButtonElement>('.trip-assessment-copy')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toContain('Cambodia (KH)');
    expect(text.split('\n').find((line) => line.startsWith('Not part of this request'))).toBe(
      'Not part of this request (an assessment covers at most 6 countries): Laos (LA).',
    );
    expect(document.querySelector('.toast-notification')?.textContent).toBe(
      'Request copied for the first 6 countries. An assessment covers at most 6 countries. Left out: Laos.',
    );
  });

  it('opens one dialog however many times the action is pressed while it loads', async () => {
    await Promise.all([openTripAssessmentForScope(SEA), openTripAssessmentForScope(SEA), openTripAssessmentForScope(SEA)]);
    expect(document.querySelectorAll('.trip-assessment')).toHaveLength(1);
  });

  it('does not open a second dialog over an open one, and brings the open one back into focus', async () => {
    await openTripAssessmentForScope(SEA);
    (document.activeElement as HTMLElement | null)?.blur();
    await openTripAssessmentForScope(SEA);
    expect(document.querySelectorAll('.trip-assessment')).toHaveLength(1);
    expect(document.activeElement).toBe(document.querySelector('.trip-assessment-label'));
  });

  it('opens again after the dialog is closed', async () => {
    await openTripAssessmentForScope(SEA);
    document.querySelector<HTMLButtonElement>('.trip-assessment .modal-close')!.click();
    expect(document.querySelector('.trip-assessment')).toBeNull();
    await openTripAssessmentForScope(SEA);
    expect(document.querySelectorAll('.trip-assessment')).toHaveLength(1);
  });

  it('copies the request for the trip as edited, not for the focus it started from', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await openTripAssessmentForScope(SEA);
    document.querySelector<HTMLButtonElement>('[data-code="VN"] [data-action="remove"]')!.click();
    const to = document.querySelector<HTMLInputElement>('.trip-assessment-to')!;
    to.value = '2026-12-20';
    to.dispatchEvent(new Event('input'));
    const type = (selector: string, value: string) => {
      const input = document.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    type('.trip-assessment-label', ' Site visit ');
    type('[data-code="TH"] .trip-assessment-cities', 'Bangkok, Chiang Mai, bangkok');
    type('[data-code="TH"] .trip-assessment-arrive', '2026-12-02');
    type('[data-code="ID"] .trip-assessment-depart', '2026-12-12');
    document.querySelector<HTMLButtonElement>('.trip-assessment-copy')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toContain('Thailand (TH), Indonesia (ID)');
    expect(text).not.toContain('Vietnam');
    expect(text).toContain('2026-12-01 to 2026-12-20');
    // What was typed in the dialog reaches the assistant too, or it would be
    // asked for a different trip than the export builds.
    expect(text).toContain('Task label: Site visit.');
    expect(text).toContain('Thailand (TH): cities Bangkok, Chiang Mai; arrive 2026-12-02.');
    expect(text).toContain('Indonesia (ID): depart 2026-12-12.');
  });
});
