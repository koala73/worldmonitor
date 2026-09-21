'use client';

import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';

import { panelLabel } from '../lib/missions';
import type { FeedItem } from '../lib/wm-mcp';

function itemsForSlot(slot: string, feeds: FeedItem[]): FeedItem[] {
  const kindHints: Record<string, string[]> = {
    'live-news': ['news', 'source'],
    intel: ['news', 'source'],
    'gdelt-intel': ['news'],
    politics: ['news'],
    markets: ['news', 'source'],
    ai: ['news'],
    tech: ['news'],
  };
  const hints = kindHints[slot] ?? ['news', 'source'];
  const matched = feeds.filter((f) => hints.includes(f.kind));
  return matched.length > 0 ? matched.slice(0, 3) : [];
}

export function FeedBento({
  slots,
  feeds,
  missionLabel,
  variant = 'grid',
  onCollapse,
}: {
  slots: string[];
  feeds: FeedItem[];
  missionLabel?: string | null;
  variant?: 'grid' | 'sidebar';
  onCollapse?: () => void;
}) {
  const cells = slots.slice(0, 6);
  while (cells.length < 6) cells.push(`empty-${cells.length}`);

  return (
    <section
      className={`wm-feed-bento${variant === 'sidebar' ? ' wm-feed-bento--sidebar' : ''}`}
      aria-label="Mission feeds"
    >
      <header className="wm-feed-bento-head">
        <Heading level={3}>Feeds</Heading>
        {missionLabel ? <Badge label={missionLabel} variant="neutral" /> : null}
        {onCollapse ? (
          <span className="wm-feed-bento-head-actions">
            <Button
              size="sm"
              variant="secondary"
              label="Hide"
              onClick={onCollapse}
            />
          </span>
        ) : null}
      </header>
      <div className="wm-feed-bento-grid">
        {cells.map((slot) => {
          if (slot.startsWith('empty-')) {
            return <div key={slot} className="wm-feed-cell wm-feed-cell--empty" aria-hidden />;
          }
          const items = itemsForSlot(slot, feeds);
          return (
            <article key={slot} className="wm-feed-cell">
              <header className="wm-feed-cell-head">
                <Text size="sm" weight="semibold">
                  {panelLabel(slot)}
                </Text>
              </header>
              {items.length > 0 ? (
                <ul className="wm-feed-cell-list">
                  {items.map((item) => (
                    <li key={item.id}>
                      {item.url ? (
                        <a href={item.url} target="_blank" rel="noopener noreferrer">
                          {item.title}
                        </a>
                      ) : (
                        <span>{item.title}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <Text size="sm" color="secondary">
                  Awaiting port
                </Text>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
