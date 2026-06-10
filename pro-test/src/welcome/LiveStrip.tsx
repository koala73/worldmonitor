import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Newspaper, ShieldAlert, Anchor, LineChart } from 'lucide-react';
import { t } from '../i18n';
import {
  fetchLiveTeasers, getFallbackTeasers,
  type TeaserState, type TeaserQuote,
} from '../services/teasers';

const STATUS_COLORS: Record<string, string> = {
  green: 'bg-wm-green',
  yellow: 'bg-[#febc2e]',
  red: 'bg-[#ff5f57]',
};

function LiveBadge({ live }: { live: boolean }) {
  return live ? (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-wm-green">
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-wm-green opacity-60" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-wm-green" />
      </span>
      {t('welcome.live.liveBadge')}
    </span>
  ) : (
    <span className="font-mono text-[10px] uppercase tracking-widest text-wm-muted">{t('welcome.live.sampleBadge')}</span>
  );
}

function Card({ icon, title, live, children }: { icon: ReactNode; title: string; live: boolean; children: ReactNode }) {
  return (
    <div className="bg-wm-card border border-wm-border rounded-sm p-5 flex flex-col gap-4 min-h-[230px]">
      <div className="flex items-center justify-between border-b border-wm-border pb-3">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-wm-muted">
          {icon} {title}
        </div>
        <LiveBadge live={live} />
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function regionFlag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '';
  const base = 0x1f1e6;
  const a = code.toUpperCase().charCodeAt(0) - 65;
  const b = code.toUpperCase().charCodeAt(1) - 65;
  return String.fromCodePoint(base + a, base + b);
}

function trendGlyph(trend: string): { glyph: string; cls: string } {
  if (trend.endsWith('RISING')) return { glyph: '▲', cls: 'text-[#ff5f57]' };
  if (trend.endsWith('FALLING')) return { glyph: '▼', cls: 'text-wm-green' };
  return { glyph: '─', cls: 'text-wm-muted' };
}

function timeAgo(ts: number): string {
  if (!ts) return '';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function Sparkline({ quote }: { quote: TeaserQuote }) {
  const pts = quote.sparkline;
  if (pts.length < 2) return null;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  const coords = pts
    .map((p, i) => `${(i / (pts.length - 1)) * 100},${24 - ((p - min) / range) * 22 + 1}`)
    .join(' ');
  const up = quote.change >= 0;
  return (
    <svg viewBox="0 0 100 26" className="w-16 h-6 shrink-0" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={coords}
        fill="none"
        stroke={up ? 'var(--color-wm-green)' : '#ff5f57'}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function formatPrice(price: number): string {
  return price >= 1000
    ? price.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const LiveStrip = () => {
  const [teasers, setTeasers] = useState<TeaserState>(getFallbackTeasers);

  useEffect(() => {
    let cancelled = false;
    fetchLiveTeasers().then(next => { if (!cancelled) setTeasers(next); });
    return () => { cancelled = true; };
  }, []);

  const disrupted = teasers.chokepoints.items.filter(c => c.status !== 'green').length;

  return (
    <section className="py-16 px-6 border-y border-wm-border bg-wm-bg relative">
      <div className="max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5 }}
          className="flex flex-col md:flex-row md:items-end md:justify-between gap-3 mb-8"
        >
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[3px] text-wm-green mb-2">{t('welcome.live.eyebrow')}</div>
            <h2 className="text-2xl md:text-3xl font-display font-bold">{t('welcome.live.title')}</h2>
          </div>
          <p className="text-sm text-wm-muted font-mono">{t('welcome.live.subtitle')}</p>
        </motion.div>

        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
          <Card icon={<Newspaper className="w-4 h-4" aria-hidden="true" />} title={t('welcome.live.cardHeadlines')} live={teasers.headlines.live}>
            <ul className="space-y-3">
              {teasers.headlines.items.map((h, i) => (
                <li key={i} className="text-sm leading-snug">
                  <span className="line-clamp-2">{h.title}</span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-wm-muted">
                    {h.source}{h.publishedAt ? ` · ${timeAgo(h.publishedAt)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card icon={<ShieldAlert className="w-4 h-4" aria-hidden="true" />} title={t('welcome.live.cardCii')} live={teasers.cii.live}>
            <ul className="space-y-2.5">
              {teasers.cii.items.map(s => {
                const trend = trendGlyph(s.trend);
                return (
                  <li key={s.region} className="flex items-center gap-3 text-sm">
                    <span className="w-12 font-mono font-bold">{regionFlag(s.region)} {s.region}</span>
                    <span className="flex-1 h-1.5 bg-wm-border rounded-full overflow-hidden">
                      <span className="block h-full bg-wm-green/70" style={{ width: `${Math.min(100, Math.max(0, s.combinedScore))}%` }} />
                    </span>
                    <span className="font-mono text-xs w-8 text-right">{Math.round(s.combinedScore)}</span>
                    <span className={`font-mono text-xs ${trend.cls}`} aria-hidden="true">{trend.glyph}</span>
                  </li>
                );
              })}
            </ul>
            <p className="font-mono text-[10px] uppercase tracking-wider text-wm-muted mt-3">{t('welcome.live.ciiNote')}</p>
          </Card>

          <Card icon={<Anchor className="w-4 h-4" aria-hidden="true" />} title={t('welcome.live.cardChokepoints')} live={teasers.chokepoints.live}>
            <p className="font-mono text-xs text-wm-muted mb-3">
              {t('welcome.live.chokeSummary', { disrupted, total: teasers.chokepoints.total })}
            </p>
            <ul className="space-y-2.5">
              {teasers.chokepoints.items.map(c => (
                <li key={c.name} className="flex items-center gap-3 text-sm">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[c.status] ?? 'bg-wm-muted'}`} aria-hidden="true" />
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="font-mono text-xs text-wm-muted">{Math.round(c.disruptionScore)}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card icon={<LineChart className="w-4 h-4" aria-hidden="true" />} title={t('welcome.live.cardMarkets')} live={teasers.quotes.live}>
            <ul className="space-y-3">
              {teasers.quotes.items.map(q => (
                <li key={q.symbol} className="flex items-center gap-3 text-sm">
                  <span className="flex-1 truncate">{q.display}</span>
                  <Sparkline quote={q} />
                  <span className="font-mono text-xs w-16 text-right">{formatPrice(q.price)}</span>
                  <span className={`font-mono text-xs w-14 text-right ${q.change >= 0 ? 'text-wm-green' : 'text-[#ff5f57]'}`}>
                    {q.change >= 0 ? '+' : ''}{q.change.toFixed(2)}%
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </section>
  );
};
