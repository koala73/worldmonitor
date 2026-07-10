import { motion } from 'motion/react';

export const SectionHeading = ({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) => (
  <motion.div
    className="text-center mb-14"
    initial={{ opacity: 0, y: 16 }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true, margin: '-80px' }}
    transition={{ duration: 0.5 }}
  >
    <div className="font-mono text-[11px] uppercase tracking-[3px] text-wm-green mb-3">{eyebrow}</div>
    <h2 className="text-3xl md:text-5xl font-display font-bold tracking-tight">{title}</h2>
    {subtitle && <p className="text-wm-muted mt-4 max-w-2xl mx-auto">{subtitle}</p>}
  </motion.div>
);
