import type { GeoPoint } from '../../shared/orbital/pass-geometry.js';
import type { PointPass } from '@/services/orbital/pass-job';
import type { MatchedAcquisition } from '@/services/orbital/match';
import { t } from '@/services/i18n';
import { h, type DomChild } from '@/utils/dom-utils';

export interface PassDetailInput {
  pass: PointPass;
  /** The archive image this pass produced, or null when none is public. */
  acquisition: MatchedAcquisition | null;
  point: GeoPoint;
  /** This pass's crop with its reticle, credit and viewer button, or a glyph tile with the tier when it made no image. */
  media: HTMLElement;
  glyph: string;
  /** Day and time of the pass, already formatted. */
  when: string;
  clock: string;
  offNadirDeg: number;
  family: string | null;
  /** The scene's pixel, else the sensor's native pixel. */
  pixelM: number | null;
  swathKm: number | null;
  hasPrevious: boolean;
  hasNext: boolean;
  clearestLook: boolean;
}

const EARTH_RADIUS_KM = 6371;
const EARTH_MU_KM3_S2 = 398_600.4418;
const DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;

/** Ground speed for a circular orbit at this altitude, used when the pass carries no propagated motion. */
export function groundSpeedKmS(altitudeKm: number): number {
  const radius = EARTH_RADIUS_KM + altitudeKm;
  return Math.sqrt(EARTH_MU_KM3_S2 / radius) * (EARTH_RADIUS_KM / radius);
}

/** The compass point, from the looked-up place, of the point under the satellite. */
export function compassFrom(from: GeoPoint, to: GeoPoint): (typeof DIRECTIONS)[number] {
  const rad = Math.PI / 180;
  const dLon = (to.lon - from.lon) * rad;
  const y = Math.sin(dLon) * Math.cos(to.lat * rad);
  const x = Math.cos(from.lat * rad) * Math.sin(to.lat * rad) - Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos(dLon);
  const bearing = (Math.atan2(y, x) / rad + 360) % 360;
  return DIRECTIONS[Math.round(bearing / 45) % 8]!;
}

function spotCondition(acquisition: MatchedAcquisition | null): string {
  if (!acquisition) return '—';
  switch (acquisition.condition) {
    case 'clear': return t('orbitalWatch.viewer.clear');
    case 'cloud': return t('orbitalWatch.viewer.clouded', { pct: Math.round(acquisition.cloudCoverPct ?? 100) });
    case 'cloud-shadow': return t('orbitalWatch.ui.caption.cloudShadow');
    case 'not-applicable': return t('orbitalWatch.ui.caption.radar');
    case 'unknown': return t('orbitalWatch.ui.caption.spotNotChecked');
  }
}

function cell(label: string, value: string): HTMLElement {
  return h('div', { className: 'ow-detail-cell' }, h('dt', { className: 'ow-label' }, label), h('dd', null, value));
}

/** The pass detail: what the satellite was, where it was, how it looked, and the image it made. */
export function renderPassDetail(input: PassDetailInput): HTMLElement {
  const { pass, acquisition } = input;
  const altitude = Math.round(pass.altitudeKm);
  const crossing = {
    name: pass.name,
    altitude,
    distance: Math.round(pass.groundDistanceKm),
    direction: t(`orbitalWatch.passDetail.dir.${compassFrom(input.point, pass.subSatellite)}`),
    time: input.clock,
    speed: (pass.motion?.groundSpeedKmS ?? groundSpeedKmS(pass.altitudeKm)).toFixed(2),
  };
  const sentence = [
    pass.motion
      ? t('orbitalWatch.passDetail.crossedHeading', { ...crossing, heading: t(`orbitalWatch.passDetail.heading.${pass.motion.heading}`) })
      : t('orbitalWatch.passDetail.crossed', crossing),
    t('orbitalWatch.passDetail.looking', { deg: input.offNadirDeg.toFixed(1) }),
    acquisition?.cloudCoverPct != null && acquisition.profileId !== 'sentinel-1'
      ? t('orbitalWatch.passDetail.sceneCloud', { pct: Math.round(acquisition.cloudCoverPct) })
      : null,
  ].filter(Boolean).join(' ');
  const sensor = [
    input.family,
    input.pixelM != null ? t('orbitalWatch.passDetail.pixelLine', { m: input.pixelM }) : null,
    input.swathKm ? t('orbitalWatch.passDetail.swathLine', { km: input.swathKm }) : null,
  ].filter(Boolean).join(' · ');
  const step = (delta: -1 | 1, label: string, enabled: boolean): DomChild =>
    h('button', { type: 'button', className: 'ow-detail-step ow-label', dataset: { action: 'detail-step', step: String(delta) }, 'aria-label': label, title: label, disabled: !enabled },
      delta < 0 ? '‹' : '›');
  return h('section', { className: 'ow-detail', 'aria-label': pass.name },
    h('button', { type: 'button', className: 'ow-detail-back ow-label', dataset: { action: 'detail-back' } },
      `← ${t('orbitalWatch.passDetail.back')} `, h('kbd', null, 'ESC')),
    h('div', { className: 'ow-detail-title' },
      h('span', { className: 'ow-glyph', 'aria-hidden': 'true' }, input.glyph),
      h('strong', null, pass.name),
      h('span', { className: 'ow-label' }, input.when)),
    input.media,
    h('dl', { className: 'ow-detail-grid' },
      cell(t('orbitalWatch.passDetail.altitude'), `${altitude} KM`),
      cell(t('orbitalWatch.passDetail.offNadir'), `${input.offNadirDeg.toFixed(1)}°`),
      cell(t('orbitalWatch.viewer.metaPixel'), input.pixelM != null ? `${input.pixelM} M` : '—'),
      cell(t('orbitalWatch.viewer.metaSpot'), spotCondition(acquisition))),
    h('p', { className: 'ow-detail-sentence' }, sentence),
    sensor ? h('p', { className: 'ow-detail-sensor ow-label' }, sensor) : null,
    h('div', { className: 'ow-detail-actions' },
      step(-1, t('orbitalWatch.passDetail.previous'), input.hasPrevious),
      h('button', { type: 'button', className: 'ow-primary', dataset: { action: 'clearest-look' }, disabled: !input.clearestLook }, t('orbitalWatch.passDetail.clearestLook')),
      h('button', { type: 'button', className: 'ow-share ow-label', dataset: { action: 'share' } }, t('orbitalWatch.ui.share')),
      step(1, t('orbitalWatch.passDetail.next'), input.hasNext)));
}
