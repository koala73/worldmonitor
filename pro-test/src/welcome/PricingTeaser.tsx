import { motion } from 'motion/react';
import { ArrowRight, Check } from 'lucide-react';
import { t } from '../i18n';
import { SectionHeading } from './SectionHeading';

export const PricingTeaser = () => (
  <section id="pricing" className="py-24 px-6 border-t border-wm-border">
    <div className="max-w-4xl mx-auto">
      <SectionHeading eyebrow={t('welcome.pricing.eyebrow')} title={t('welcome.pricing.title')} />
      <div className="grid md:grid-cols-2 gap-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.5 }}
          className="bg-wm-card border border-wm-border rounded-sm p-8"
        >
          <h3 className="font-display font-bold text-2xl mb-1">{t('welcome.pricing.freeTitle')}</h3>
          <div className="font-mono text-xs uppercase tracking-widest text-wm-green mb-4">$0</div>
          <p className="text-sm text-wm-muted">{t('welcome.pricing.freeDesc')}</p>
          <a
            href="/"
            className="mt-6 inline-flex items-center gap-2 border border-wm-border text-wm-text px-5 py-2.5 rounded-sm font-mono text-xs uppercase tracking-wider font-bold hover:border-wm-green/50 transition-colors"
          >
            {t('welcome.nav.launch')} <ArrowRight className="w-3 h-3" aria-hidden="true" />
          </a>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="bg-wm-card border border-wm-green/30 rounded-sm p-8 border-glow"
        >
          <h3 className="font-display font-bold text-2xl mb-1">{t('welcome.pricing.proTitle')}</h3>
          <div className="font-mono text-xs uppercase tracking-widest text-wm-muted mb-4">{t('welcome.pricing.note')}</div>
          <p className="text-sm text-wm-muted mb-4">{t('welcome.pricing.proDesc')}</p>
          <ul className="space-y-2.5 mb-6">
            {[1, 2, 3].map(n => (
              <li key={n} className="flex items-start gap-2 text-sm">
                <Check className="w-4 h-4 text-wm-green shrink-0 mt-0.5" aria-hidden="true" />
                {t(`welcome.pricing.proF${n}`)}
              </li>
            ))}
          </ul>
          <a
            href="/pro#pricing"
            className="inline-flex items-center gap-2 bg-wm-green text-wm-bg px-5 py-2.5 rounded-sm font-mono text-xs uppercase tracking-wider font-bold hover:bg-green-400 transition-colors"
          >
            {t('welcome.pricing.cta')} <ArrowRight className="w-3 h-3" aria-hidden="true" />
          </a>
        </motion.div>
      </div>
    </div>
  </section>
);
