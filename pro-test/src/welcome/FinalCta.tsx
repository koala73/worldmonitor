import { motion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { t } from '../i18n';
import { DASHBOARD_PATH } from '../routes';
import depthProofStats from '../generated/depth-stats.json';

export const FinalCta = () => (
  <section className="py-28 px-6 border-t border-wm-border relative overflow-hidden">
    <motion.div
      initial={false}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6 }}
      className="max-w-3xl mx-auto text-center relative"
    >
      <h2 className="text-3xl md:text-5xl font-display font-medium tracking-tight">{t('welcome.cta.title')}</h2>
      <p className="text-wm-muted mt-4">{t('welcome.cta.subtitle', depthProofStats)}</p>
      <div className="mt-9">
        <a
          href={DASHBOARD_PATH}
          data-umami-event="welcome-cta"
          data-umami-event-target="welcome-final"
          className="inline-flex min-h-12 py-3 items-center justify-center gap-2 rounded-md bg-wm-green px-6 text-sm font-medium text-wm-bg transition-colors hover:bg-green-300"
        >
          {t('welcome.cta.button')} <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </a>
        <div className="mt-3 font-mono text-xs text-wm-muted">{t('welcome.cta.note')}</div>
      </div>
      <a href="/pro" data-umami-event="welcome-cta" data-umami-event-target="welcome-final-pro" className="inline-block mt-6 text-sm text-wm-muted hover:text-wm-text transition-colors">
        {t('welcome.cta.secondary')}
      </a>
    </motion.div>
  </section>
);
