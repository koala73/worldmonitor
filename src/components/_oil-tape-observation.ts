import { t } from '@/services/i18n';
import type { MarketData } from '@/types';
import { isStaleOilPrice, oilTapeMaxAgeMs } from '../../shared/oil-price-observation';

export type OilTapeObservation = Pick<MarketData, 'priceBasis' | 'priceSource' | 'priceAt'>;

export function oilTapeObservationLabel(quote: OilTapeObservation): string {
  const { priceBasis, priceSource, priceAt } = quote;
  const date = new Date(priceAt ?? 0);
  const iso = priceAt && Number.isFinite(date.getTime()) ? date.toISOString() : '';
  const time = priceBasis === 'futures' && iso
    ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
    : iso.slice(0, 10);
  const basis = priceBasis === 'futures' ? t('components.energyComplex.futures')
    : priceBasis === 'spot' ? t('components.energyComplex.dailySpot')
    : '';
  const stale = isStaleOilPrice(priceAt, oilTapeMaxAgeMs(priceBasis));
  return [
    basis, priceSource || t('components.energyComplex.unknownQuoteSource'),
    time || t('components.energyComplex.unknownPriceDate'),
    stale ? t('components.energyComplex.stalePrice') : '',
  ].filter(Boolean).join(' · ');
}
