import { motion } from 'motion/react';
import { t } from '../i18n';
import { SectionHeading } from './SectionHeading';

type ChipTier = 'free' | 'pro';

interface MomentConfig {
  key: 'm1' | 'm2' | 'm3' | 'm4';
  twoLineTitle: boolean;
  times: string[];
  chips: ChipTier[];
  href: string;
}

const MOMENTS: MomentConfig[] = [
  { key: 'm1', twoLineTitle: false, times: ['02:10', '02:25', '02:30', '02:41'], chips: ['free', 'free', 'free', 'free'], href: '/?ref=welcome-m1' },
  { key: 'm2', twoLineTitle: true, times: ['05:58', '06:02', '06:05', '06:15'], chips: ['free', 'free', 'pro', 'pro'], href: '/?ref=welcome-m2' },
  { key: 'm3', twoLineTitle: false, times: ['09:12', '09:13', '09:15', '09:30'], chips: ['free', 'free', 'free'], href: '/?ref=welcome-m3' },
  { key: 'm4', twoLineTitle: true, times: ['14:02', '14:07', '14:09', '07:00'], chips: ['free', 'free', 'pro', 'pro'], href: 'https://finance.worldmonitor.app/?ref=welcome-m4' },
];

const CHIP_CLASS: Record<ChipTier, string> = {
  free: 'border-wm-green/30 bg-wm-green/10 text-wm-green',
  pro: 'border-amber-400/30 bg-amber-400/10 text-amber-400',
};

const STEP_DOT: Record<ChipTier, string> = {
  free: 'bg-wm-green',
  pro: 'bg-amber-400',
};

export const Moments = () => (
  <section id="moments" className="py-24 px-6 border-t border-wm-border">
    <div className="max-w-6xl mx-auto">
      <SectionHeading
        eyebrow={t('welcome.moments.eyebrow')}
        title={t('welcome.moments.title')}
        subtitle={t('welcome.moments.sub')}
      />
      <div className="grid md:grid-cols-2 gap-6">
        {MOMENTS.map(({ key, twoLineTitle, times, chips, href }, mi) => {
          const stepTiers: ChipTier[] = times.map((_, si) => {
            if (key === 'm2' && si === 2) return 'pro';
            if (key === 'm4' && si === 2) return 'pro';
            return 'free';
          });
          return (
            <motion.article
              key={key}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.5, delay: (mi % 2) * 0.1 }}
              className="bg-wm-card border border-wm-border rounded-sm p-8 hover:border-wm-green/30 transition-colors flex flex-col"
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
              <div className="space-y-4 mb-6 flex-1">
                {times.map((time, si) => (
                  <div key={si} className="relative pl-6">
                    {si < times.length - 1 && (
                      <span className="absolute left-[3px] top-4 bottom-[-14px] w-px bg-wm-border" aria-hidden="true" />
                    )}
                    <span className={`absolute left-0 top-1.5 w-[7px] h-[7px] rounded-full ${si === times.length - 1 ? 'bg-wm-text' : STEP_DOT[stepTiers[si] ?? 'free']}`} aria-hidden="true" />
                    <p className="text-sm text-wm-muted">
                      <span className={`font-mono text-xs mr-2 ${stepTiers[si] === 'pro' ? 'text-amber-400' : si === times.length - 1 ? 'text-wm-text' : 'text-wm-green'}`}>{time}</span>
                      {t(`welcome.moments.${key}.s${si + 1}`)}
                    </p>
                  </div>
                ))}
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
