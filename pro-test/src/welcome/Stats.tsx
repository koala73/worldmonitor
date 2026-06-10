import { motion } from 'motion/react';
import { t } from '../i18n';

const STATS = ['feeds', 'layers', 'countries', 'providers', 'mcpTools', 'languages'] as const;

export const Stats = () => (
  <section className="py-16 px-6 border-t border-wm-border">
    <div className="max-w-7xl mx-auto">
      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: '-60px' }}
        transition={{ duration: 0.6 }}
      >
        <div className="font-mono text-[11px] uppercase tracking-[3px] text-wm-green mb-6 text-center">{t('welcome.stats.eyebrow')}</div>
        <div className="data-grid !grid-cols-2 sm:!grid-cols-3 xl:!grid-cols-6">
          {STATS.map(key => (
            <div key={key} className="data-cell text-center">
              <div className="text-3xl md:text-4xl font-display font-bold text-wm-green text-glow">{t(`welcome.stats.${key}Value`)}</div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-wm-muted mt-2">{t(`welcome.stats.${key}`)}</div>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  </section>
);
