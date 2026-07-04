import { motion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { t } from '../i18n';
import { DASHBOARD_PATH } from '../routes';
import { SectionHeading } from './SectionHeading';

const STEPS = [
  { time: '0:00', n: 1 },
  { time: '0:40', n: 2 },
  { time: '2:00', n: 3 },
  { time: '3:30', n: 4 },
  { time: '5:00', n: 5 },
] as const;

export const FirstFive = () => (
  <section id="first-five" className="py-24 px-6 border-t border-wm-border relative">
    <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_30%,rgba(74,222,128,0.05)_0%,transparent_50%)] pointer-events-none" aria-hidden="true" />
    <div className="max-w-4xl mx-auto relative">
      <SectionHeading
        eyebrow={t('welcome.firstFive.eyebrow')}
        title={t('welcome.firstFive.title')}
        subtitle={t('welcome.firstFive.sub')}
      />
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-60px' }}
        transition={{ duration: 0.5 }}
        className="border border-wm-border rounded-sm overflow-hidden divide-y divide-wm-border"
      >
        {STEPS.map(({ time, n }) => (
          <div key={n} className="bg-wm-card p-6 flex gap-6 items-start">
            <span className="font-mono text-sm text-wm-green w-14 shrink-0 pt-0.5">{time}</span>
            <div>
              <h3 className="font-display font-bold mb-1">{t(`welcome.firstFive.f${n}Title`)}</h3>
              <p className="text-sm text-wm-muted">{t(`welcome.firstFive.f${n}Desc`)}</p>
            </div>
          </div>
        ))}
      </motion.div>
      <div className="text-center mt-10">
        <a
          href={`${DASHBOARD_PATH}?ref=welcome-f5m`}
          className="bg-wm-green text-wm-bg px-6 py-3 rounded-sm font-mono text-sm uppercase tracking-wider font-bold hover:bg-green-400 transition-colors inline-flex items-center gap-2"
        >
          {t('welcome.firstFive.cta')} <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </a>
      </div>
    </div>
  </section>
);
