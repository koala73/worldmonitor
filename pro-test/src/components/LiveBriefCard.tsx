import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { currentLanguageBase, t } from '../i18n';
import {
  fetchLiveTeasers, formatSnapshotDate, getFallbackTeasers,
  type TeaserState,
} from '../services/teasers';

/**
 * The /pro brief preview. It used to be a hand-written Slack message with
 * invented figures; it now renders the same data the homepage live strip
 * shows. It starts from the committed published pulse (a frozen capture of
 * real data, labelled with its date) and upgrades each block in place when the
 * live fetch succeeds. Nothing on this card is made up.
 */

const ms = (ts: number) => (ts < 1e12 ? ts * 1000 : ts);

function timeAgo(ts: number): string {
  if (!ts) return '';
  const mins = Math.max(0, Math.round((Date.now() - ms(ts)) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function formatChange(change: number): string {
  const sign = change > 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}

export const LiveBriefCard = () => {
  const [teasers, setTeasers] = useState<TeaserState>(getFallbackTeasers);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    let cancelled = false;
    fetchLiveTeasers()
      .then(next => { if (!cancelled) setTeasers(next); })
      .catch(() => { /* keep the published-pulse fallback */ });
    return () => { cancelled = true; };
  }, []);

  const live = teasers.headlines.live && teasers.chokepoints.live && teasers.quotes.live;
  // Blocks refresh independently. When only some went live, each block names
  // its own source so a live headline never sits under the snapshot date.
  const mixed = !live && (teasers.headlines.live || teasers.chokepoints.live || teasers.quotes.live);
  const pulseLabel = t('welcome.live.pulseBadge', { date: formatSnapshotDate(teasers.capturedAt) });
  const blockTag = (isLive: boolean) => (mixed ? (
    <span className="ml-2 font-mono text-xs uppercase tracking-wider text-gray-500">
      {isLive ? t('welcome.live.liveBadge') : pulseLabel}
    </span>
  ) : null);
  const newest = teasers.headlines.items.reduce((max, h) => Math.max(max, h.publishedAt || 0), 0);
  // Clock times depend on the reader's time zone, so they only render after
  // mount; the prerendered HTML carries the published-pulse date instead.
  const stamp = mounted && live && newest
    ? new Intl.DateTimeFormat(currentLanguageBase(), { hour: 'numeric', minute: '2-digit' }).format(new Date(ms(newest)))
    : '';
  const disrupted = teasers.chokepoints.items.filter(c => c.status !== 'green').slice(0, 3);

  return (
    <div className="bg-[#1a1d21] rounded-lg border border-[#35373b] overflow-hidden shadow-2xl lg:sticky lg:top-24">
      <div className="bg-[#222529] px-4 py-3 border-b border-[#35373b] flex items-center gap-3">
        <div className="w-3 h-3 rounded-full bg-red-500" />
        <div className="w-3 h-3 rounded-full bg-yellow-500" />
        <div className="w-3 h-3 rounded-full bg-green-500" />
        <span className="ml-2 font-mono text-xs text-gray-400">#world-monitor-alerts</span>
      </div>
      <div className="p-6 font-sans text-sm">
        <div className="flex gap-4">
          <div className="w-10 h-10 rounded bg-wm-green/20 flex items-center justify-center shrink-0">
            <Globe className="w-6 h-6 text-wm-green" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2 mb-3">
              <span className="font-bold text-gray-200">World Monitor</span>
              <span className="text-xs text-gray-500 bg-gray-800 px-1 rounded">APP</span>
              {stamp && <span className="text-xs text-gray-500">{stamp}</span>}
              {live ? (
                <span className="inline-flex items-center gap-1 text-xs font-mono uppercase tracking-wider text-wm-green">
                  <span className="w-1.5 h-1.5 rounded-full bg-wm-green animate-pulse" aria-hidden="true" />
                  {t('welcome.live.liveBadge')}
                </span>
              ) : mixed ? null : (
                <span className="text-xs font-mono uppercase tracking-wider text-gray-500">
                  {pulseLabel}
                </span>
              )}
            </div>

            <div className="space-y-4">
              <div className="pl-3 border-l-2 border-blue-500">
                <span className="text-blue-400 font-bold text-xs uppercase tracking-wider">{t('welcome.live.cardHeadlines')}</span>{blockTag(teasers.headlines.live)}
                <ul className="mt-1 space-y-2">
                  {teasers.headlines.items.slice(0, 3).map((h, i) => (
                    <li key={i} className="text-gray-300 leading-snug">
                      {h.url ? (
                        <a href={h.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-white transition-colors">
                          {h.title}
                        </a>
                      ) : h.title}
                      <span className="block font-mono text-xs text-gray-500">
                        {h.source}{mounted && h.publishedAt ? ` · ${timeAgo(h.publishedAt)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="pl-3 border-l-2 border-orange-500">
                <span className="text-orange-400 font-bold text-xs uppercase tracking-wider">{t('welcome.live.cardChokepoints')}</span>{blockTag(teasers.chokepoints.live)}
                <p className="text-sm text-gray-300 mt-1 leading-snug">
                  {t('welcome.live.chokeSummary', { disrupted: teasers.chokepoints.disrupted, total: teasers.chokepoints.total })}
                  {disrupted.length > 0 && `: ${disrupted.map(c => c.name).join(', ')}`}
                </p>
              </div>

              <div className="pl-3 border-l-2 border-yellow-500">
                <span className="text-yellow-400 font-bold text-xs uppercase tracking-wider">{t('welcome.live.cardMarkets')}</span>{blockTag(teasers.quotes.live)}
                <ul className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                  {teasers.quotes.items.slice(0, 4).map(q => (
                    <li key={q.symbol} className="flex justify-between gap-2 font-mono text-xs">
                      <span className="text-gray-300 truncate">{q.display}</span>
                      <span className={q.change > 0 ? 'text-wm-green' : q.change < 0 ? 'text-red-400' : 'text-gray-400'}>
                        {formatChange(q.change)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
