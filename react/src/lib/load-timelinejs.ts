/**
 * Load TimelineJS from prebuilt dist (UMD + CSS).
 * Avoids the package main entry, which pulls Less source Vite cannot compile.
 */

import timelineCssUrl from '@knight-lab/timelinejs/dist/css/timeline.css?url';
import timelineJsUrl from '@knight-lab/timelinejs/dist/js/timeline.js?url';

export type TimelineCtor = new (
  el: string | HTMLElement,
  data: unknown,
  options?: Record<string, unknown>,
) => {
  on: (event: string, cb: (data?: unknown) => void) => void;
  goToId: (id: string) => void;
  goToEnd: () => void;
  current_id?: string;
};

declare global {
  interface Window {
    TL?: { Timeline: TimelineCtor };
  }
}

let loading: Promise<TimelineCtor> | null = null;

export function loadTimelineCtor(): Promise<TimelineCtor> {
  if (typeof window !== 'undefined' && window.TL?.Timeline) {
    return Promise.resolve(window.TL.Timeline);
  }
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      if (!document.querySelector('link[data-wm-timelinejs-css]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = timelineCssUrl;
        link.dataset.wmTimelinejsCss = '1';
        document.head.appendChild(link);
      }
      const existing = document.querySelector('script[data-wm-timelinejs-js]');
      if (existing) {
        existing.addEventListener('load', () => {
          if (window.TL?.Timeline) resolve(window.TL.Timeline);
          else reject(new Error('TimelineJS loaded without TL.Timeline'));
        });
        return;
      }
      const script = document.createElement('script');
      script.src = timelineJsUrl;
      script.async = true;
      script.dataset.wmTimelinejsJs = '1';
      script.onload = () => {
        if (window.TL?.Timeline) resolve(window.TL.Timeline);
        else reject(new Error('TimelineJS loaded without TL.Timeline'));
      };
      script.onerror = () => reject(new Error('Failed to load TimelineJS'));
      document.head.appendChild(script);
    });
  }
  return loading;
}
