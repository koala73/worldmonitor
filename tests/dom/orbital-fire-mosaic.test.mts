/**
 * #10713: which GIBS daily mosaic belongs to a FIRMS detection. The instrument
 * picks the layer, the detection's UTC date picks the day, and the time-domain
 * request carries no position. An empty answer is `none`, never a fallback day.
 */
import { describe, expect, it, vi } from 'vitest';
import { instrumentOf, loadFireMosaic } from '@/services/orbital/fire-mosaic';

const DETECTED = Date.parse('2026-11-14T23:50:00Z');
const POINT = { lat: 48.5, lon: 37.25 };

function domainReply(domain: string): Response {
  return new Response(`<Domain>${domain}</Domain>`, { status: 200 });
}

describe('instrumentOf', () => {
  it('maps the FIRMS satellite codes to the GIBS daily layers', () => {
    expect(instrumentOf('N')).toEqual({ label: 'VIIRS Suomi NPP', mosaic: 'VIIRS Suomi NPP' });
    expect(instrumentOf('N20')).toEqual({ label: 'VIIRS NOAA-20', mosaic: 'VIIRS NOAA-20' });
    expect(instrumentOf('Terra')).toEqual({ label: 'MODIS Terra', mosaic: 'MODIS Terra' });
    expect(instrumentOf('Aqua')).toEqual({ label: 'MODIS Aqua', mosaic: 'MODIS Aqua' });
  });

  it('knows NOAA-21 but has no GIBS daily layer for it', () => {
    expect(instrumentOf('N21')).toEqual({ label: 'VIIRS NOAA-21', mosaic: null });
  });

  it('does not guess for an unknown code', () => {
    expect(instrumentOf('ZZ9')).toEqual({ label: 'ZZ9', mosaic: null });
    expect(instrumentOf(undefined)).toEqual({ label: null, mosaic: null });
  });
});

describe('loadFireMosaic', () => {
  it('returns the instrument layer image for the detection UTC date', async () => {
    const fetch = vi.fn(async () => domainReply('2026-11-14/2026-11-14/P1D'));
    const result = await loadFireMosaic(POINT, DETECTED, 'N', { fetch });
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result).toMatchObject({ source: 'VIIRS Suomi NPP', date: '2026-11-14', archive: 'nasa-gibs' });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toContain('VIIRS_SNPP_CorrectedReflectance_TrueColor');
    expect(result.candidates[0]).toContain('TIME=2026-11-14');
  });

  it('asks GIBS about the one layer, and its time-domain request carries no position', async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => { urls.push(String(input)); return domainReply('2026-11-14/2026-11-14/P1D'); });
    await loadFireMosaic(POINT, DETECTED, 'N20', { fetch });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('VIIRS_NOAA20_CorrectedReflectance_TrueColor');
    expect(urls[0]).not.toContain('48.5');
    expect(urls[0]).not.toContain('37.25');
  });

  it('is none for that date when the layer has no day inside the detection date', async () => {
    const fetch = vi.fn(async () => domainReply('2026-11-01/2026-11-13/P1D'));
    expect(await loadFireMosaic(POINT, DETECTED, 'N', { fetch })).toEqual({
      status: 'none', source: 'VIIRS Suomi NPP', date: '2026-11-14', reason: 'no-day',
    });
  });

  it('is none without any request for an instrument with no GIBS daily layer', async () => {
    const fetch = vi.fn();
    expect(await loadFireMosaic(POINT, DETECTED, 'N21', { fetch })).toEqual({ status: 'none', date: '2026-11-14', reason: 'no-layer' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is failed when the archive does not answer, which is not the same as no mosaic', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 503 }));
    expect((await loadFireMosaic(POINT, DETECTED, 'N', { fetch })).status).toBe('failed');
  });
});
