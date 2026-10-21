import { track } from '@/services/analytics';
import { getCurrentLanguageTag, t } from '@/services/i18n';
import { playAllLiveMedia } from '@/services/live-media-controller';
import { formatIdleStopMinutes, setLiveMediaIdleStop } from '@/services/live-stream-settings';
import { showToast } from '@/utils/toast';

export type LiveMediaIdlePanelId = 'live-news' | 'live-webcams';

export interface LiveMediaIdleNoticeOptions {
  readonly panel: LiveMediaIdlePanelId;
  readonly heading: string;
  readonly idleAfterMs: number;
}

function toIdleMinutes(idleAfterMs: number): number {
  return Math.round(idleAfterMs / 60_000);
}

/** Records an idle stop for one panel, with the duration that elapsed in minutes. */
export function trackLiveMediaIdleStop(panel: LiveMediaIdlePanelId, idleAfterMs: number): void {
  track('live-media-idle-stopped', { panel, idleMinutes: toIdleMinutes(idleAfterMs) });
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'offline-retry';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

/**
 * Builds the "paused for inactivity" notice a live panel shows in place of its media after an idle
 * stop. Resume restarts through the play-all cascade; "Keep playing when idle" saves `never`,
 * confirms with a toast, and then resumes.
 */
export function createLiveMediaIdleNotice({ panel, heading, idleAfterMs }: LiveMediaIdleNoticeOptions): HTMLElement {
  const idleMinutes = toIdleMinutes(idleAfterMs);

  const status = document.createElement('div');
  status.className = 'live-media-shell-status';
  const dot = document.createElement('span');
  dot.className = 'live-media-shell-dot';
  const statusText = document.createElement('span');
  statusText.textContent = t('components.liveMedia.idleStatus');
  status.append(dot, statusText);

  const title = document.createElement('div');
  title.className = 'live-media-shell-title';
  title.textContent = heading;

  const body = document.createElement('p');
  body.className = 'live-media-shell-body';
  body.textContent = t('components.liveMedia.idleBody', {
    duration: formatIdleStopMinutes(idleMinutes, getCurrentLanguageTag()),
  });

  const resume = actionButton(t('components.liveMedia.idleResume'), () => {
    track('live-media-idle-notice-action', { panel, action: 'resume', idleMinutes });
    playAllLiveMedia();
  });
  const keepPlaying = actionButton(t('components.liveMedia.idleKeepPlaying'), () => {
    track('live-media-idle-notice-action', { panel, action: 'keep-playing', idleMinutes });
    setLiveMediaIdleStop('never');
    showToast(t('components.liveMedia.idleKeepPlayingToast'));
    playAllLiveMedia();
  });
  keepPlaying.classList.add('live-media-shell-secondary');

  const actions = document.createElement('div');
  actions.className = 'live-media-shell-actions';
  actions.append(resume, keepPlaying);

  const hint = document.createElement('p');
  hint.className = 'live-media-shell-hint';
  hint.textContent = t('components.liveMedia.idleSettingsHint');

  const notice = document.createElement('div');
  notice.className = 'live-media-shell live-media-shell--idle';
  notice.setAttribute('role', 'status');
  notice.append(status, title, body, actions, hint);
  return notice;
}
