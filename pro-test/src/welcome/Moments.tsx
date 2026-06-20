import { motion } from 'motion/react';
import { t } from '../i18n';
import { DASHBOARD_PATH } from '../routes';
import { SectionHeading } from './SectionHeading';

type ChipTier = 'free' | 'pro';

interface MomentConfig {
  key: 'm1' | 'm2' | 'm3' | 'm4';
  twoLineTitle: boolean;
  signals: string[];
  chips: ChipTier[];
  href: string;
}

const MOMENTS: MomentConfig[] = [
  { key: 'm1', twoLineTitle: true, signals: ['RISK', 'FLOW', 'MACRO', 'PRICE'], chips: ['free', 'free', 'pro', 'pro'], href: 'https://finance.worldmonitor.app/dashboard?ref=welcome-m1' },
  { key: 'm2', twoLineTitle: true, signals: ['AIS', 'WEATHER', 'SUPPLY', 'SPREAD'], chips: ['free', 'free', 'pro', 'pro'], href: 'https://commodity.worldmonitor.app/dashboard?ref=welcome-m2' },
  { key: 'm3', twoLineTitle: true, signals: ['AI', 'GRID', 'CLIMATE', 'MARKET'], chips: ['free', 'free', 'pro', 'pro'], href: 'https://tech.worldmonitor.app/dashboard?ref=welcome-m3' },
  { key: 'm4', twoLineTitle: false, signals: ['CABLE', 'BGP', 'PORTS', 'RISK'], chips: ['free', 'free', 'free', 'free'], href: `${DASHBOARD_PATH}?ref=welcome-m4` },
];

const CHIP_CLASS: Record<ChipTier, string> = {
  free: 'border-wm-green/30 bg-wm-green/10 text-wm-green',
  pro: 'border-amber-400/30 bg-amber-400/10 text-amber-400',
};

export const Moments = () => (
  <section id="moments" className="py-24 px-4 sm:px-6 border-t border-wm-border">
    <div className="max-w-6xl mx-auto">
      <SectionHeading
        eyebrow={t('welcome.moments.eyebrow')}
        title={t('welcome.moments.title')}
        subtitle={t('welcome.moments.sub')}
      />
      <div className="grid md:grid-cols-2 gap-6">
        {MOMENTS.map(({ key, twoLineTitle, signals, chips, href }, mi) => {
          const signalRows = signals.slice(0, -1);
          const correlationCode = signals[signals.length - 1] ?? 'SYNC';
          const correlationTier = chips[chips.length - 1] ?? 'free';
          return (
            <motion.article
              key={key}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.5, delay: (mi % 2) * 0.1 }}
              className="bg-wm-card border border-wm-border rounded-sm p-6 sm:p-8 hover:border-wm-green/30 transition-colors flex flex-col"
            >
              <p className="font-mono text-[11px] uppercase tracking-[2px] text-wm-green mb-2">{t(`welcome.moments.${key}.kicker`)}</p>
              <h3 className="text-2xl font-display font-bold mb-6">
                {twoLineTitle ? (
                  <>
                    {t(`welcome.moments.${key}.title1`)}
                    <br />
                    {t(`welcome.moments.${key}.title2`)}
                  </>
                ) : (
                  t(`welcome.moments.${key}.title`)
                )}
              </h3>
              <div className="mb-6 flex-1">
                <div className="font-mono text-[10px] uppercase tracking-[2px] text-wm-muted mb-3">
                  {t('welcome.moments.signalStack')}
                </div>
                <div className="space-y-3">
                  {signalRows.map((signal, si) => (
                    <div key={signal} className="grid grid-cols-[4.75rem_1fr] gap-3 items-start">
                      <span className={`mt-0.5 inline-flex items-center justify-center rounded-sm border px-2 py-1 font-mono text-[10px] ${CHIP_CLASS[chips[si] ?? 'free']}`}>
                        {signal}
                      </span>
                      <p className="text-sm text-wm-muted leading-relaxed">
                        {t(`welcome.moments.${key}.s${si + 1}`)}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="mt-5 border-t border-wm-border pt-5">
                  <div className="grid grid-cols-[4.75rem_1fr] gap-3 items-start">
                    <span className={`mt-0.5 inline-flex items-center justify-center rounded-sm border px-2 py-1 font-mono text-[10px] ${CHIP_CLASS[correlationTier]}`}>
                      {correlationCode}
                    </span>
                    <div>
                      <p className="font-mono text-[10px] uppercase tracking-[2px] text-wm-text mb-1">
                        {t('welcome.moments.correlation')}
                      </p>
                      <p className="text-sm text-wm-text leading-relaxed">
                        {t(`welcome.moments.${key}.s${signals.length}`)}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mb-6">
                {chips.map((tier, ci) => (
                  <span key={ci} className={`px-2.5 py-1 rounded-full border text-[10px] font-mono ${CHIP_CLASS[tier]}`}>
                    {t(`welcome.moments.${key}.c${ci + 1}`)}
                  </span>
                ))}
              </div>
              <a href={href} className="font-mono text-xs text-wm-green hover:text-green-300 transition-colors">
                {t(`welcome.moments.${key}.link`)}
              </a>
            </motion.article>
          );
        })}
      </div>
      <motion.p
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 0.5 }}
        className="text-center text-wm-muted mt-12"
      >
        <span className="text-wm-text font-medium">{t('welcome.moments.bridge1')}</span> {t('welcome.moments.bridge2')}
      </motion.p>
    </div>
  </section>
);
