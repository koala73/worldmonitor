import { beforeAll, describe, expect, it } from 'vitest';
import { DeckGLMap } from '@/components/DeckGLMap';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);
const hostile = '<img src=x onerror="alert(1)">';
const tooltip = (DeckGLMap.prototype as unknown as {
  getTooltip(info: unknown): { html: string };
}).getTooltip;

describe('feed values at the map HTML boundary', () => {
  it.each([
    ['military-vessel-clusters-layer', { name: hostile, vesselCount: hostile }],
    ['military-flight-clusters-layer', { name: hostile, flightCount: hostile }],
    ['bases-cluster-layer', { count: hostile }],
    ['protest-clusters-layer', { count: hostile, country: hostile }],
    ['tech-hq-clusters-layer', { count: hostile, city: hostile }],
    ['tech-event-clusters-layer', { count: hostile, location: hostile }],
    ['datacenter-clusters-layer', { count: hostile, country: hostile }],
    ['storm-centers-layer', { stormName: hostile, windKt: hostile, windAveragingPeriodMinutes: hostile }],
    ['storm-past-track-layer', { stormName: hostile, windKt: hostile }],
    ['renewable-installations-layer', { name: hostile, type: hostile, capacityMW: hostile, year: hostile }],
    ['gulf-investments-layer', { assetName: hostile, investmentUSD: hostile }],
  ])('%s renders hostile feed text without elements', (id, object) => {
    const host = document.createElement('div');
    host.innerHTML = tooltip.call({}, { layer: { id }, object }).html;
    expect(host.querySelector('img,script,svg')).toBeNull();
    if ('name' in object || 'assetName' in object || 'stormName' in object) {
      expect(host.textContent).toContain(hostile);
    }
  });

  it.each(['earthquakes-layer', 'ddos-locations-layer'])('%s accepts malformed numeric input without throwing', id => {
    expect(() => tooltip.call({}, { layer: { id }, object: { magnitude: hostile, percentage: hostile } })).not.toThrow();
  });
});
