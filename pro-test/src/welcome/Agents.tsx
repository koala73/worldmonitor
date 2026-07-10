import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import { t } from '../i18n';

// Registry install commands are product identifiers, not prose — they stay
// untranslated on purpose (same reason the tool names below do).
const INSTALL_CHIPS = [
  { cmd: 'npm i worldmonitor', href: 'https://www.npmjs.com/package/worldmonitor' },
  { cmd: 'pip install worldmonitor-sdk', href: 'https://pypi.org/project/worldmonitor-sdk/' },
  { cmd: 'gem install worldmonitor', href: 'https://rubygems.org/gems/worldmonitor' },
  { cmd: 'go get github.com/koala73/worldmonitor/sdk/go', href: 'https://pkg.go.dev/github.com/koala73/worldmonitor/sdk/go' },
] as const;

export const Agents = () => (
  <section id="agents" className="py-24 px-6 border-t border-wm-border">
    <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-12 items-center">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-60px' }}
        transition={{ duration: 0.5 }}
      >
        <div className="font-mono text-[11px] uppercase tracking-[3px] text-wm-green mb-3">{t('welcome.agents.eyebrow')}</div>
        <h2 className="text-3xl md:text-5xl font-display font-bold tracking-tight mb-6">{t('welcome.agents.title')}</h2>
        <p className="text-wm-muted mb-6">{t('welcome.agents.sub')}</p>
        <ul className="space-y-3 mb-6 text-sm">
          {[1, 2, 3, 4].map(n => (
            <li key={n} className="flex items-start gap-2.5">
              <Check className="w-4 h-4 text-wm-green shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-wm-muted">{t(`welcome.agents.b${n}`)}</span>
            </li>
          ))}
        </ul>
        <div className="mb-6 rounded-sm border border-wm-border bg-wm-card/70 font-mono text-[11px] leading-none">
          {INSTALL_CHIPS.map(({ cmd, href }, i) => (
            <a
              key={cmd}
              href={href}
              target="_blank"
              rel="noreferrer"
              className={`flex items-center gap-2 px-4 py-2.5 text-wm-muted hover:text-wm-text hover:bg-wm-bg/60 transition-colors ${i > 0 ? 'border-t border-wm-border' : ''}`}
            >
              <span className="text-wm-green" aria-hidden="true">$</span>
              <span className="truncate">{cmd}</span>
            </a>
          ))}
        </div>
        <p className="font-mono text-xs uppercase tracking-wider text-wm-text mb-8">{t('welcome.agents.promise')}</p>
        <a
          href="https://www.worldmonitor.app/docs"
          className="border border-wm-border text-wm-text px-6 py-3 rounded-sm font-mono text-sm uppercase tracking-wider font-bold hover:border-wm-green/50 transition-colors inline-block"
        >
          {t('welcome.agents.cta')}
        </a>
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-60px' }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="bg-wm-card border border-wm-border rounded-md overflow-hidden border-glow"
      >
        <div className="flex items-center gap-1.5 px-4 h-9 border-b border-wm-border bg-wm-bg/80">
          <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" aria-hidden="true" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" aria-hidden="true" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" aria-hidden="true" />
          <span className="ml-3 font-mono text-[10px] uppercase tracking-widest text-wm-muted">{t('welcome.agents.termTitle')}</span>
        </div>
        <div className="p-6 font-mono text-xs leading-relaxed">
          <p className="text-wm-text mb-4">&gt; {t('welcome.agents.termQuery')}</p>
          <p className="text-wm-muted mb-1">
            <span className="text-wm-green" aria-hidden="true">⏺</span> get_chokepoint_status{' '}
            <span className="text-wm-blue">{'{'}jmespath: "chokepoints[?name=='Bab el-Mandeb']"{'}'}</span>
          </p>
          <p className="text-wm-muted mb-1">
            <span className="text-wm-green" aria-hidden="true">⏺</span> get_country_risk <span className="text-wm-blue">{'{'}country: "YE"{'}'}</span>
          </p>
          <p className="text-wm-muted mb-4">
            <span className="text-wm-green" aria-hidden="true">⏺</span> get_maritime_activity <span className="text-wm-blue">{'{'}region: "red_sea"{'}'}</span>
          </p>
          <p className="text-wm-text mb-2"><span className="text-wm-green" aria-hidden="true">✓</span> {t('welcome.agents.termAnswer')}</p>
          <p>
            <a href="https://www.worldmonitor.app/docs" className="text-wm-green hover:text-green-300 transition-colors">{t('welcome.agents.termDocs')}</a>
          </p>
        </div>
      </motion.div>
    </div>
  </section>
);
