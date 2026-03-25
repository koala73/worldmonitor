/**
 * Skeleton Loading Components
 *
 * Provides shimmer animation placeholders for loading states.
 * Replaces static "Loading..." text with visual skeleton cards.
 */

import { h } from '@/utils/dom-utils';

/**
 * Create a single skeleton card element
 * Mimics the structure of a news card with animated placeholders
 */
export function createSkeletonCard(): HTMLElement {
  return h('div', { className: 'skeleton-card' },
    h('div', { className: 'skeleton-title skeleton-shimmer' }),
    h('div', { className: 'skeleton-meta' },
      h('div', { className: 'skeleton-source skeleton-shimmer' }),
      h('div', { className: 'skeleton-time skeleton-shimmer' }),
    ),
  );
}

/**
 * Create a skeleton panel with multiple cards
 * @param count - Number of skeleton cards to display (default: 4)
 */
export function createSkeletonPanel(count = 4): HTMLElement {
  const panel = h('div', { className: 'skeleton-panel' });
  for (let i = 0; i < count; i++) {
    panel.appendChild(createSkeletonCard());
  }
  return panel;
}

/**
 * Render skeleton HTML string (for innerHTML usage)
 * @param count - Number of skeleton cards
 */
export function renderSkeletonHtml(count = 4): string {
  const cards = Array.from({ length: count }, () => `
    <div class="skeleton-card">
      <div class="skeleton-title skeleton-shimmer"></div>
      <div class="skeleton-meta">
        <div class="skeleton-source skeleton-shimmer"></div>
        <div class="skeleton-time skeleton-shimmer"></div>
      </div>
    </div>
  `).join('');

  return `<div class="skeleton-panel">${cards}</div>`;
}

/**
 * Enhanced skeleton with optional header
 * Used for panels that show count in header
 */
export function createSkeletonWithHeader(
  _title: string,
  count = 4
): HTMLElement {
  const wrapper = h('div', { className: 'skeleton-wrapper' });
  wrapper.appendChild(createSkeletonPanel(count));
  return wrapper;
}
