import { Sparkles } from 'lucide-react';
import { t } from '../i18n';

/**
 * Monthly shipping recap: new features from the last ~30 days, product-wide,
 * with paid items tagged PRO inline. Content lives in the whatsNew.* locale
 * keys; ITEMS pins which entries exist and which carry the PRO tag, so the
 * tag can't drift in translation. Rotate the list when the next month's
 * features ship — it is a freshness signal, not a permanent banner.
 */
const ITEMS: ReadonlyArray<{ key: string; pro: boolean }> = [
  { key: 'm1', pro: true },
  { key: 'm2', pro: true },
  { key: 'm3', pro: true },
  { key: 'm4', pro: true },
  { key: 'm5', pro: false },
  { key: 'm6', pro: false },
  { key: 'm7', pro: false },
  { key: 'm8', pro: false },
];

export function WhatsNew() {
  return (
    <section aria-labelledby="whats-new-title" className="max-w-4xl mx-auto px-6 py-12">
      <p className="font-mono text-xs text-wm-green uppercase tracking-widest mb-2 flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
        {t('whatsNew.eyebrow')}
      </p>
      <h2 id="whats-new-title" className="text-2xl md:text-3xl font-display font-bold mb-1">
        {t('whatsNew.title')}
      </h2>
      <p className="text-sm text-wm-muted mb-6">{t('whatsNew.subtitle')}</p>
      <ul className="grid gap-2.5 sm:grid-cols-2">
        {ITEMS.map(({ key, pro }) => (
          <li key={key} className="flex items-start gap-2 text-sm">
            <span className="text-wm-green mt-0.5" aria-hidden="true">
              ▸
            </span>
            <span>
              {t(`whatsNew.${key}`)}
              {pro && (
                <span className="ml-2 align-middle inline-block font-mono text-[10px] font-semibold uppercase tracking-wider text-wm-green border border-wm-green/40 rounded px-1 py-px">
                  {t('whatsNew.proTag')}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
