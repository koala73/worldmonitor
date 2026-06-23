import { motion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { t } from '../i18n';
import { DASHBOARD_PATH } from '../routes';

export const FinalCta = () => (
  <section className="py-28 px-6 border-t border-wm-border relative overflow-hidden">
    <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_100%,rgba(74,222,128,0.10)_0%,transparent_55%)] pointer-events-none" aria-hidden="true" />
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6 }}
      className="max-w-3xl mx-auto text-center relative"
    >
      <h2 className="text-3xl md:text-5xl font-display font-bold tracking-tight">{t('welcome.cta.title')}</h2>
      <p className="text-wm-muted mt-4">{t('welcome.cta.subtitle')}</p>
      <div className="mt-9">
        <a
          href={`${DASHBOARD_PATH}?ref=welcome-final`}
          className="bg-wm-green text-wm-bg px-10 py-4 rounded-sm font-mono text-sm uppercase tracking-wider font-bold hover:bg-green-400 transition-colors inline-flex items-center gap-2"
        >
          {t('welcome.cta.button')} <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </a>
        <div className="mt-3 font-mono text-[11px] uppercase tracking-widest text-wm-muted">{t('welcome.cta.note')}</div>
      </div>
      <a href="/pro" className="inline-block mt-6 text-sm text-wm-muted hover:text-wm-green transition-colors font-mono">
        {t('welcome.cta.secondary')}
      </a>
    </motion.div>
  </section>
);
