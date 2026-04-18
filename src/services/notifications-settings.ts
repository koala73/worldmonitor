import { escapeHtml } from '@/utils/sanitize';
import { renderSVG } from 'uqr';
import {
  getChannelsData,
  createPairingToken,
  setEmailChannel,
  setWebhookChannel,
  startSlackOAuth,
  startDiscordOAuth,
  deleteChannel,
  saveAlertRules,
  setQuietHours,
  setDigestSettings,
  type NotificationChannel,
  type ChannelType,
  type QuietHoursOverride,
  type DigestMode,
} from '@/services/notification-channels';
import { getCurrentClerkUser } from '@/services/clerk';
import { hasTier } from '@/services/entitlements';
import { SITE_VARIANT } from '@/config/variant';

const QUIET_HOURS_BATCH_ENABLED = import.meta.env.VITE_QUIET_HOURS_BATCH_ENABLED !== '0';
const DIGEST_CRON_ENABLED = import.meta.env.VITE_DIGEST_CRON_ENABLED !== '0';

export interface NotificationsSettingsHost {
  isSignedIn?: boolean;
}

export interface NotificationsSettingsResult {
  html: string;
  attach: (container: HTMLElement) => () => void;
}

export function renderNotificationsSettings(host: NotificationsSettingsHost): NotificationsSettingsResult {
  const isPro = !!host.isSignedIn && hasTier(1);

  let html = '';
  if (isPro) {
    html += `<div class="wm-pref-group-content wm-notif-tab-content">`;
    html += `<div class="us-notif-loading" id="usNotifLoading">Loading...</div>`;
    html += `<div class="us-notif-content" id="usNotifContent" style="display:none"></div>`;
    html += `</div>`;
  } else {
    html += `<div class="wm-pref-group-content wm-notif-tab-content">`;
    html += `<div class="ai-flow-toggle-desc">Get real-time intelligence alerts delivered to Telegram, Slack, Discord, and Email with configurable sensitivity, quiet hours, and digest scheduling.</div>`;
    html += `<button type="button" class="panel-locked-cta" id="usNotifUpgradeBtn">Upgrade to Pro</button>`;
    html += `</div>`;
  }

  return {
    html,
    attach(container: HTMLElement): () => void {
      const ac = new AbortController();
      const { signal } = ac;

      if (!isPro) {
        const upgradeBtn = container.querySelector<HTMLButtonElement>('#usNotifUpgradeBtn');
        if (upgradeBtn) {
          upgradeBtn.addEventListener('click', () => {
            if (!host.isSignedIn) {
              import('@/services/clerk').then(m => m.openSignIn()).catch(() => {
                window.open('https://worldmonitor.app/pro', '_blank');
              });
              return;
            }
            import('@/services/checkout').then(m => import('@/config/products').then(p => m.startCheckout(p.DEFAULT_UPGRADE_PRODUCT))).catch(() => {
              window.open('https://worldmonitor.app/pro', '_blank');
            });
          }, { signal });
        }
        return () => ac.abort();
      }

      let notifPollInterval: ReturnType<typeof setInterval> | null = null;

      function clearNotifPoll(): void {
        if (notifPollInterval !== null) {
          clearInterval(notifPollInterval);
          notifPollInterval = null;
        }
      }

      signal.addEventListener('abort', clearNotifPoll);

      function channelIcon(type: ChannelType): string {
        if (type === 'telegram') return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`;
        if (type === 'email') return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`;
        if (type === 'web_push') return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`;
        if (type === 'webhook') return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
        if (type === 'discord') return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`;
        return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/></svg>`;
      }

      const CHANNEL_LABELS: Record<ChannelType, string> = { telegram: 'Telegram', email: 'Email', slack: 'Slack', discord: 'Discord', webhook: 'Webhook', web_push: 'Browser Push' };

      function renderChannelRow(channel: NotificationChannel | null, type: ChannelType): string {
        const icon = channelIcon(type);
        const name = CHANNEL_LABELS[type];

        if (channel?.verified) {
          let sub: string;
          let manageLink = '';
          if (type === 'telegram') {
            sub = `@${escapeHtml(channel.chatId ?? 'connected')}`;
          } else if (type === 'email') {
            sub = escapeHtml(channel.email ?? 'connected');
          } else if (type === 'discord') {
            sub = 'Connected';
          } else if (type === 'webhook') {
            sub = channel.webhookLabel ? escapeHtml(channel.webhookLabel) : 'Connected';
          } else if (type === 'web_push') {
            // User-Agent is long and ugly. Surface a short label only:
            // "Chrome", "Firefox", "Safari", etc.
            const ua = channel.userAgent ?? '';
            const browser = /Firefox\/|Chrome\/|Edge\/|Safari\//.exec(ua)?.[0]?.replace('/', '') ?? 'This device';
            sub = escapeHtml(browser);
          } else {
            const rawCh = channel.slackChannelName ?? '';
            const ch = rawCh ? `#${escapeHtml(rawCh.startsWith('#') ? rawCh.slice(1) : rawCh)}` : 'connected';
            const team = channel.slackTeamName ? ` · ${escapeHtml(channel.slackTeamName)}` : '';
            sub = ch + team;
            if (channel.slackConfigurationUrl) {
              manageLink = `<a href="${escapeHtml(channel.slackConfigurationUrl)}" target="_blank" rel="noopener noreferrer" class="us-notif-manage-link">Manage</a>`;
            }
          }
          return `<div class="us-notif-ch-row us-notif-ch-on" data-channel-type="${type}">
            <div class="us-notif-ch-icon">${icon}</div>
            <div class="us-notif-ch-body">
              <div class="us-notif-ch-name">${name}</div>
              <div class="us-notif-ch-sub">${sub}</div>
            </div>
            <div class="us-notif-ch-actions">
              <span class="us-notif-ch-badge">Connected</span>
              ${manageLink}
              <button type="button" class="us-notif-ch-btn us-notif-disconnect" data-channel="${type}">Remove</button>
            </div>
          </div>`;
        }

        if (type === 'telegram') {
          return `<div class="us-notif-ch-row" data-channel-type="telegram">
            <div class="us-notif-ch-icon">${icon}</div>
            <div class="us-notif-ch-body">
              <div class="us-notif-ch-name">${name}</div>
              <div class="us-notif-ch-sub">Not connected</div>
            </div>
            <div class="us-notif-ch-actions">
              <button type="button" class="us-notif-ch-btn us-notif-ch-btn-primary us-notif-telegram-connect" id="usConnectTelegram">Connect</button>
            </div>
          </div>`;
        }

        if (type === 'email') {
          return `<div class="us-notif-ch-row" data-channel-type="email">
            <div class="us-notif-ch-icon">${icon}</div>
            <div class="us-notif-ch-body">
              <div class="us-notif-ch-name">${name}</div>
              <div class="us-notif-ch-sub">Use your account email</div>
            </div>
            <div class="us-notif-ch-actions">
              <button type="button" class="us-notif-ch-btn us-notif-ch-btn-primary us-notif-email-connect" id="usConnectEmail">Link</button>
            </div>
          </div>`;
        }

        if (type === 'slack') {
          return `<div class="us-notif-ch-row" data-channel-type="slack">
            <div class="us-notif-ch-icon">${icon}</div>
            <div class="us-notif-ch-body">
              <div class="us-notif-ch-name">${name}</div>
              <div class="us-notif-ch-sub">Not connected</div>
            </div>
            <div class="us-notif-ch-actions">
              <button type="button" class="us-notif-slack-oauth" id="usConnectSlack">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right:5px;vertical-align:-1px"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/></svg>
                Add to Slack
              </button>
            </div>
          </div>`;
        }

        if (type === 'discord') {
          return `<div class="us-notif-ch-row" data-channel-type="discord">
            <div class="us-notif-ch-icon">${icon}</div>
            <div class="us-notif-ch-body">
              <div class="us-notif-ch-name">${name}</div>
              <div class="us-notif-ch-sub">Not connected</div>
            </div>
            <div class="us-notif-ch-actions">
              <button type="button" class="us-notif-discord-oauth" id="usConnectDiscord">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right:5px;vertical-align:-1px"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
                Connect Discord
              </button>
            </div>
          </div>`;
        }

        if (type === 'webhook') {
          return `<div class="us-notif-ch-row" data-channel-type="webhook">
            <div class="us-notif-ch-icon">${icon}</div>
            <div class="us-notif-ch-body">
              <div class="us-notif-ch-name">${name}</div>
              <div class="us-notif-ch-sub">Send structured JSON to any HTTPS endpoint</div>
            </div>
            <div class="us-notif-ch-actions">
              <button type="button" class="us-notif-ch-btn us-notif-ch-btn-primary" id="usConnectWebhook">Add URL</button>
            </div>
          </div>`;
        }

        if (type === 'web_push') {
          return `<div class="us-notif-ch-row" data-channel-type="web_push">
            <div class="us-notif-ch-icon">${icon}</div>
            <div class="us-notif-ch-body">
              <div class="us-notif-ch-name">${name}</div>
              <div class="us-notif-ch-sub">Native notifications on this device. Enabling here replaces any previously registered browser.</div>
            </div>
            <div class="us-notif-ch-actions">
              <button type="button" class="us-notif-ch-btn us-notif-ch-btn-primary" id="usConnectWebPush">Enable</button>
            </div>
          </div>`;
        }

        return '';
      }

      const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

      function renderNotifContent(data: Awaited<ReturnType<typeof getChannelsData>>): string {
        const channelTypes: ChannelType[] = ['telegram', 'email', 'slack', 'discord', 'webhook', 'web_push'];
        const alertRule = data.alertRules?.[0] ?? null;
        const sensitivity = alertRule?.sensitivity ?? 'all';

        let html = '<div class="ai-flow-section-label">Channels</div>';
        for (const type of channelTypes) {
          const channel = data.channels.find(c => c.channelType === type) ?? null;
          html += renderChannelRow(channel, type);
        }

        const qhEnabled = alertRule?.quietHoursEnabled ?? false;
        const qhStart = alertRule?.quietHoursStart ?? 22;
        const qhEnd = alertRule?.quietHoursEnd ?? 7;
        const qhOverride = alertRule?.quietHoursOverride ?? 'critical_only';

        const digestMode = alertRule?.digestMode ?? 'realtime';
        const digestHour = alertRule?.digestHour ?? 8;
        const aiDigestEnabled = alertRule?.aiDigestEnabled ?? true;

        const hourOptions = Array.from({ length: 24 }, (_, h) => {
          const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
          return `<option value="${h}"${h === qhStart ? ' selected' : ''}>${label}</option>`;
        }).join('');
        const hourOptionsEnd = Array.from({ length: 24 }, (_, h) => {
          const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
          return `<option value="${h}"${h === qhEnd ? ' selected' : ''}>${label}</option>`;
        }).join('');
        const hourOptionsDigest = Array.from({ length: 24 }, (_, h) => {
          const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
          return `<option value="${h}"${h === digestHour ? ' selected' : ''}>${label}</option>`;
        }).join('');

        const TZ_LIST = [
          'UTC',
          'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
          'America/Anchorage', 'America/Honolulu', 'America/Phoenix',
          'America/Toronto', 'America/Vancouver', 'America/Mexico_City',
          'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'America/Bogota',
          'America/Lima', 'America/Santiago', 'America/Caracas',
          'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
          'Europe/Rome', 'Europe/Amsterdam', 'Europe/Stockholm', 'Europe/Oslo',
          'Europe/Zurich', 'Europe/Warsaw', 'Europe/Athens', 'Europe/Bucharest',
          'Europe/Helsinki', 'Europe/Istanbul', 'Europe/Moscow', 'Europe/Kyiv',
          'Africa/Cairo', 'Africa/Nairobi', 'Africa/Lagos', 'Africa/Johannesburg',
          'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka',
          'Asia/Bangkok', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Hong_Kong',
          'Asia/Tokyo', 'Asia/Seoul', 'Asia/Manila',
          'Australia/Sydney', 'Australia/Brisbane', 'Australia/Perth',
          'Pacific/Auckland', 'Pacific/Fiji',
        ];
        const makeTzOptions = (current: string) => {
          const list = TZ_LIST.includes(current) ? TZ_LIST : [current, ...TZ_LIST];
          return list.map(tz => `<option value="${tz}"${tz === current ? ' selected' : ''}>${tz}</option>`).join('');
        };

        const isRealtime = !DIGEST_CRON_ENABLED || digestMode === 'realtime';
        const sharedTz = isRealtime
          ? (alertRule?.quietHoursTimezone ?? alertRule?.digestTimezone ?? detectedTz)
          : (alertRule?.digestTimezone ?? alertRule?.quietHoursTimezone ?? detectedTz);

        html += `<div class="ai-flow-section-label" style="margin-top:8px">Delivery Mode</div>
          ${!DIGEST_CRON_ENABLED ? '<div class="ai-flow-toggle-desc" style="margin-bottom:4px">Digest delivery is not yet active.</div>' : ''}
          <select class="unified-settings-select" id="usDigestMode"${!DIGEST_CRON_ENABLED ? ' disabled' : ''}>
            <option value="realtime"${isRealtime ? ' selected' : ''}>Real-time (immediate)</option>
            ${DIGEST_CRON_ENABLED ? `<option value="daily"${digestMode === 'daily' ? ' selected' : ''}>Daily digest</option>
            <option value="twice_daily"${digestMode === 'twice_daily' ? ' selected' : ''}>Twice daily</option>
            <option value="weekly"${digestMode === 'weekly' ? ' selected' : ''}>Weekly digest</option>` : ''}
          </select>
          <div id="usRealtimeSection" style="${isRealtime ? '' : 'display:none'}">
            <div class="ai-flow-section-label" style="margin-top:8px">Alert Rules</div>
            <div class="ai-flow-toggle-row">
              <div class="ai-flow-toggle-label-wrap">
                <div class="ai-flow-toggle-label">Enable notifications</div>
                <div class="ai-flow-toggle-desc">Receive alerts for events matching your filters</div>
              </div>
              <label class="ai-flow-switch">
                <input type="checkbox" id="usNotifEnabled"${alertRule?.enabled ? ' checked' : ''}>
                <span class="ai-flow-slider"></span>
              </label>
            </div>
            <div class="ai-flow-section-label">Sensitivity</div>
            <select class="unified-settings-select" id="usNotifSensitivity">
              <option value="all"${sensitivity === 'all' ? ' selected' : ''}>All events</option>
              <option value="high"${sensitivity === 'high' ? ' selected' : ''}>High &amp; critical</option>
              <option value="critical"${sensitivity === 'critical' ? ' selected' : ''}>Critical only</option>
            </select>
            <div class="ai-flow-section-label" style="margin-top:8px">Quiet Hours</div>
            <div class="ai-flow-toggle-row">
              <div class="ai-flow-toggle-label-wrap">
                <div class="ai-flow-toggle-label">Enable quiet hours</div>
                <div class="ai-flow-toggle-desc">Suppress or batch non-critical alerts during set hours</div>
              </div>
              <label class="ai-flow-switch">
                <input type="checkbox" id="usQhEnabled"${qhEnabled ? ' checked' : ''}>
                <span class="ai-flow-slider"></span>
              </label>
            </div>
            <div id="usQhDetails" style="${qhEnabled ? '' : 'display:none'}">
              <div class="ai-flow-toggle-row" style="gap:8px;flex-wrap:wrap">
                <div class="ai-flow-toggle-label-wrap" style="min-width:60px">
                  <div class="ai-flow-toggle-label">From</div>
                </div>
                <select class="unified-settings-select" id="usQhStart" style="width:auto">${hourOptions}</select>
                <div class="ai-flow-toggle-label-wrap" style="min-width:30px">
                  <div class="ai-flow-toggle-label">To</div>
                </div>
                <select class="unified-settings-select" id="usQhEnd" style="width:auto">${hourOptionsEnd}</select>
              </div>
              <div style="margin-top:4px">
                <div class="ai-flow-toggle-label" style="margin-bottom:4px">During quiet hours</div>
                <select class="unified-settings-select" id="usQhOverride">
                  <option value="critical_only"${qhOverride === 'critical_only' ? ' selected' : ''}>Critical only (suppress others)</option>
                  <option value="silence_all"${qhOverride === 'silence_all' ? ' selected' : ''}>Silence all</option>
                  ${QUIET_HOURS_BATCH_ENABLED ? `<option value="batch_on_wake"${qhOverride === 'batch_on_wake' ? ' selected' : ''}>Batch — deliver on wake</option>` : ''}
                </select>
              </div>
            </div>
          </div>
          <div id="usDigestDetails" style="${isRealtime ? 'display:none' : ''}">
            <div class="ai-flow-toggle-row" style="gap:8px;flex-wrap:wrap;margin-top:4px">
              <div class="ai-flow-toggle-label-wrap" style="min-width:60px">
                <div class="ai-flow-toggle-label">Send at</div>
              </div>
              <select class="unified-settings-select" id="usDigestHour" style="width:auto">${hourOptionsDigest}</select>
            </div>
            <div id="usTwiceDailyHint" class="ai-flow-toggle-desc" style="margin-top:4px;${digestMode === 'twice_daily' ? '' : 'display:none'}">Also sends at ${((digestHour + 12) % 24) === 0 ? '12 AM' : ((digestHour + 12) % 24) < 12 ? `${(digestHour + 12) % 24} AM` : ((digestHour + 12) % 24) === 12 ? '12 PM' : `${((digestHour + 12) % 24) - 12} PM`}</div>
            <div class="ai-flow-toggle-row" style="margin-top:8px">
              <div class="ai-flow-toggle-label-wrap">
                <div class="ai-flow-toggle-label">AI executive summary</div>
                <div class="ai-flow-toggle-desc">Prepend a personalized intelligence brief tailored to your watchlist and interests</div>
              </div>
              <label class="ai-flow-switch">
                <input type="checkbox" id="usAiDigestEnabled"${aiDigestEnabled ? ' checked' : ''}>
                <span class="ai-flow-slider"></span>
              </label>
            </div>
          </div>
          <div class="ai-flow-section-label" style="margin-top:8px">Timezone</div>
          <select class="unified-settings-select" id="usSharedTimezone" style="width:100%">${makeTzOptions(sharedTz)}</select>`;
        return html;
      }

      function reloadNotifSection(): void {
        const loadingEl = container.querySelector<HTMLElement>('#usNotifLoading');
        const contentEl = container.querySelector<HTMLElement>('#usNotifContent');
        if (!loadingEl || !contentEl) return;
        loadingEl.style.display = 'block';
        contentEl.style.display = 'none';
        if (signal.aborted) return;
        getChannelsData().then((data) => {
          if (signal.aborted) return;
          contentEl.innerHTML = renderNotifContent(data);
          loadingEl.style.display = 'none';
          contentEl.style.display = 'block';
        }).catch((err) => {
          if (signal.aborted) return;
          console.error('[notifications] Failed to load settings:', err);
          if (loadingEl) loadingEl.textContent = 'Failed to load notification settings.';
        });
      }

      reloadNotifSection();

      function saveRuleWithNewChannel(newChannel: ChannelType): void {
        const enabledEl = container.querySelector<HTMLInputElement>('#usNotifEnabled');
        const sensitivityEl = container.querySelector<HTMLSelectElement>('#usNotifSensitivity');
        if (!enabledEl) return;
        const enabled = enabledEl.checked;
        const sensitivity = (sensitivityEl?.value ?? 'all') as 'all' | 'high' | 'critical';
        const existing = Array.from(container.querySelectorAll<HTMLElement>('[data-channel-type]'))
          .filter(el => el.classList.contains('us-notif-ch-on'))
          .map(el => el.dataset.channelType as ChannelType);
        const channels = [...new Set([...existing, newChannel])];
        const aiEl = container.querySelector<HTMLInputElement>('#usAiDigestEnabled');
        void saveAlertRules({ variant: SITE_VARIANT, enabled, eventTypes: [], sensitivity, channels, aiDigestEnabled: aiEl?.checked ?? true });
      }

      let slackOAuthPopup: Window | null = null;
      let discordOAuthPopup: Window | null = null;
      let alertRuleDebounceTimer: ReturnType<typeof setTimeout> | null = null;
      let qhDebounceTimer: ReturnType<typeof setTimeout> | null = null;
      let digestDebounceTimer: ReturnType<typeof setTimeout> | null = null;
      signal.addEventListener('abort', () => {
        if (alertRuleDebounceTimer !== null) {
          clearTimeout(alertRuleDebounceTimer);
          alertRuleDebounceTimer = null;
        }
        if (qhDebounceTimer !== null) {
          clearTimeout(qhDebounceTimer);
          qhDebounceTimer = null;
        }
        if (digestDebounceTimer !== null) {
          clearTimeout(digestDebounceTimer);
          digestDebounceTimer = null;
        }
      });

      const saveQuietHours = () => {
        if (qhDebounceTimer) clearTimeout(qhDebounceTimer);
        qhDebounceTimer = setTimeout(() => {
          const enabledEl = container.querySelector<HTMLInputElement>('#usQhEnabled');
          const startEl = container.querySelector<HTMLSelectElement>('#usQhStart');
          const endEl = container.querySelector<HTMLSelectElement>('#usQhEnd');
          const tzEl = container.querySelector<HTMLSelectElement>('#usSharedTimezone');
          const overrideEl = container.querySelector<HTMLSelectElement>('#usQhOverride');
          void setQuietHours({
            variant: SITE_VARIANT,
            quietHoursEnabled: enabledEl?.checked ?? false,
            quietHoursStart: startEl ? Number(startEl.value) : 22,
            quietHoursEnd: endEl ? Number(endEl.value) : 7,
            quietHoursTimezone: tzEl?.value || detectedTz,
            quietHoursOverride: (overrideEl?.value ?? 'critical_only') as QuietHoursOverride,
          });
        }, 800);
      };

      const saveDigestSettings = () => {
        if (digestDebounceTimer) clearTimeout(digestDebounceTimer);
        digestDebounceTimer = setTimeout(() => {
          const modeEl = container.querySelector<HTMLSelectElement>('#usDigestMode');
          const hourEl = container.querySelector<HTMLSelectElement>('#usDigestHour');
          const tzEl = container.querySelector<HTMLSelectElement>('#usSharedTimezone');
          void setDigestSettings({
            variant: SITE_VARIANT,
            digestMode: (modeEl?.value ?? 'realtime') as DigestMode,
            digestHour: hourEl ? Number(hourEl.value) : 8,
            digestTimezone: tzEl?.value || detectedTz,
          });
        }, 800);
      };

      container.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        if (target.id === 'usQhEnabled') {
          const details = container.querySelector<HTMLElement>('#usQhDetails');
          if (details) details.style.display = target.checked ? '' : 'none';
          saveQuietHours();
          return;
        }
        if (target.id === 'usQhStart' || target.id === 'usQhEnd' || target.id === 'usQhOverride') {
          saveQuietHours();
          return;
        }
        if (target.id === 'usDigestMode') {
          const isRt = target.value === 'realtime';
          const realtimeSection = container.querySelector<HTMLElement>('#usRealtimeSection');
          const digestDetails = container.querySelector<HTMLElement>('#usDigestDetails');
          const twiceHint = container.querySelector<HTMLElement>('#usTwiceDailyHint');
          if (realtimeSection) realtimeSection.style.display = isRt ? '' : 'none';
          if (digestDetails) digestDetails.style.display = isRt ? 'none' : '';
          if (twiceHint) twiceHint.style.display = target.value === 'twice_daily' ? '' : 'none';
          saveDigestSettings();
          if (!isRt) {
            const enabledEl = container.querySelector<HTMLInputElement>('#usNotifEnabled');
            if (enabledEl && !enabledEl.checked) {
              enabledEl.checked = true;
              enabledEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          return;
        }
        if (target.id === 'usDigestHour') {
          const twiceHint = container.querySelector<HTMLElement>('#usTwiceDailyHint');
          if (twiceHint) {
            const h = (Number(target.value) + 12) % 24;
            twiceHint.textContent = `Also sends at ${h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`}`;
          }
          saveDigestSettings();
          return;
        }
        if (target.id === 'usSharedTimezone') {
          saveQuietHours();
          saveDigestSettings();
          return;
        }
        if (target.id === 'usAiDigestEnabled') {
          if (alertRuleDebounceTimer) clearTimeout(alertRuleDebounceTimer);
          alertRuleDebounceTimer = setTimeout(() => {
            const enabledEl = container.querySelector<HTMLInputElement>('#usNotifEnabled');
            const sensitivityEl = container.querySelector<HTMLSelectElement>('#usNotifSensitivity');
            const enabled = enabledEl?.checked ?? false;
            const sensitivity = (sensitivityEl?.value ?? 'all') as 'all' | 'high' | 'critical';
            const connectedChannelTypes = Array.from(
              container.querySelectorAll<HTMLElement>('[data-channel-type]'),
            )
              .filter(el => el.classList.contains('us-notif-ch-on'))
              .map(el => el.dataset.channelType as ChannelType);
            void saveAlertRules({
              variant: SITE_VARIANT,
              enabled,
              eventTypes: [],
              sensitivity,
              channels: connectedChannelTypes,
              aiDigestEnabled: target.checked,
            });
          }, 500);
          return;
        }
        if (target.id === 'usNotifEnabled' || target.id === 'usNotifSensitivity') {
          if (alertRuleDebounceTimer) clearTimeout(alertRuleDebounceTimer);
          alertRuleDebounceTimer = setTimeout(() => {
            const enabledEl = container.querySelector<HTMLInputElement>('#usNotifEnabled');
            const sensitivityEl = container.querySelector<HTMLSelectElement>('#usNotifSensitivity');
            const enabled = enabledEl?.checked ?? false;
            const sensitivity = (sensitivityEl?.value ?? 'all') as 'all' | 'high' | 'critical';
            const connectedChannelTypes = Array.from(
              container.querySelectorAll<HTMLElement>('[data-channel-type]'),
            )
              .filter(el => el.classList.contains('us-notif-ch-on'))
              .map(el => el.dataset.channelType as ChannelType);
            const aiDigestEl = container.querySelector<HTMLInputElement>('#usAiDigestEnabled');
            void saveAlertRules({
              variant: SITE_VARIANT,
              enabled,
              eventTypes: [],
              sensitivity,
              channels: connectedChannelTypes,
              aiDigestEnabled: aiDigestEl?.checked ?? true,
            });
          }, 1000);
        }
      }, { signal });

      container.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;

        if (target.closest('.us-notif-tg-copy-btn')) {
          const btn = target.closest('.us-notif-tg-copy-btn') as HTMLButtonElement;
          const cmd = btn.dataset.cmd ?? '';
          const markCopied = () => {
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
          };
          const execFallback = () => {
            const ta = document.createElement('textarea');
            ta.value = cmd;
            ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); markCopied(); } catch { /* ignore */ }
            document.body.removeChild(ta);
          };
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(cmd).then(markCopied).catch(execFallback);
          } else {
            execFallback();
          }
          return;
        }

        const startTelegramPairing = (rowEl: HTMLElement) => {
          rowEl.innerHTML = `<div class="us-notif-ch-icon">${channelIcon('telegram')}</div><div class="us-notif-ch-body"><div class="us-notif-ch-name">Telegram</div><div class="us-notif-ch-sub">Generating code…</div></div>`;
          createPairingToken().then(({ token, expiresAt }) => {
            if (signal.aborted) return;
            const botUsername = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_TELEGRAM_BOT_USERNAME as string | undefined) ?? 'WorldMonitorBot';
            const deepLink = `https://t.me/${String(botUsername)}?start=${token}`;
            const startCmd = `/start ${token}`;
            const secsLeft = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
            const qrSvg = renderSVG(deepLink, { ecc: 'M', border: 1 });
            rowEl.innerHTML = `
              <div class="us-notif-ch-icon">${channelIcon('telegram')}</div>
              <div class="us-notif-ch-body">
                <div class="us-notif-ch-name">Connect Telegram</div>
                <div class="us-notif-ch-sub">Open the bot. If Telegram doesn't send the code automatically, paste this command.</div>
                <div class="us-notif-tg-pair-layout">
                  <div class="us-notif-tg-cmd-col">
                    <a href="${escapeHtml(deepLink)}" target="_blank" rel="noopener noreferrer" class="us-notif-tg-link">Open Telegram</a>
                    <div class="us-notif-tg-cmd-row">
                      <code class="us-notif-tg-cmd">${escapeHtml(startCmd)}</code>
                      <button type="button" class="us-notif-tg-copy-btn" data-cmd="${escapeHtml(startCmd)}">Copy</button>
                    </div>
                  </div>
                  <div class="us-notif-tg-qr" title="Scan with mobile Telegram">${qrSvg}</div>
                </div>
              </div>
              <div class="us-notif-ch-actions">
                <span class="us-notif-tg-countdown" id="usTgCountdown">Waiting… ${secsLeft}s</span>
              </div>
            `;
            let remaining = secsLeft;
            clearNotifPoll();
            notifPollInterval = setInterval(() => {
              if (signal.aborted) { clearNotifPoll(); return; }
              remaining -= 3;
              const countdownEl = container.querySelector<HTMLElement>('#usTgCountdown');
              if (countdownEl) countdownEl.textContent = `Waiting… ${Math.max(0, remaining)}s`;
              const expired = remaining <= 0;
              if (expired) {
                clearNotifPoll();
                rowEl.innerHTML = `
                  <div class="us-notif-ch-icon">${channelIcon('telegram')}</div>
                  <div class="us-notif-ch-body">
                    <div class="us-notif-ch-name">Telegram</div>
                    <div class="us-notif-ch-sub us-notif-tg-expired">Code expired</div>
                  </div>
                  <div class="us-notif-ch-actions">
                    <button type="button" class="us-notif-ch-btn us-notif-ch-btn-primary us-notif-tg-regen">Generate new code</button>
                  </div>
                `;
                return;
              }
              getChannelsData().then((data) => {
                const tg = data.channels.find(c => c.channelType === 'telegram');
                if (tg?.verified) {
                  clearNotifPoll();
                  saveRuleWithNewChannel('telegram');
                  reloadNotifSection();
                }
              }).catch(() => {});
            }, 3000);
          }).catch(() => {
            rowEl.innerHTML = `<div class="us-notif-ch-icon">${channelIcon('telegram')}</div><div class="us-notif-ch-body"><div class="us-notif-ch-name">Telegram</div><div class="us-notif-ch-sub us-notif-tg-expired">Failed to generate code</div></div><div class="us-notif-ch-actions"><button type="button" class="us-notif-ch-btn us-notif-ch-btn-primary us-notif-tg-regen">Try again</button></div>`;
          });
        };

        if (target.closest('#usConnectTelegram') || target.closest('.us-notif-tg-regen')) {
          const rowEl = target.closest('.us-notif-ch-row') as HTMLElement | null;
          if (!rowEl) return;
          startTelegramPairing(rowEl);
          return;
        }

        if (target.closest('#usConnectEmail')) {
          const user = getCurrentClerkUser();
          const email = user?.email;
          if (!email) {
            const rowEl = target.closest('.us-notif-ch-row') as HTMLElement | null;
            if (rowEl) {
              rowEl.querySelector('.us-notif-error')?.remove();
              rowEl.insertAdjacentHTML('beforeend', '<span class="us-notif-error">No email found on your account</span>');
            }
            return;
          }
          setEmailChannel(email).then(() => {
            if (!signal.aborted) { saveRuleWithNewChannel('email'); reloadNotifSection(); }
          }).catch(() => {});
          return;
        }

        if (target.closest('#usConnectSlack')) {
          const btn = target.closest<HTMLButtonElement>('#usConnectSlack');
          if (slackOAuthPopup && !slackOAuthPopup.closed) {
            slackOAuthPopup.focus();
            return;
          }
          if (btn) btn.textContent = 'Connecting…';
          startSlackOAuth().then((oauthUrl) => {
            if (signal.aborted) return;
            const popup = window.open(oauthUrl, 'slack-oauth', 'width=600,height=700,menubar=no,toolbar=no');
            if (!popup) {
              if (btn) btn.textContent = 'Add to Slack';
              const rowEl = btn?.closest<HTMLElement>('[data-channel-type="slack"]');
              if (rowEl) {
                rowEl.querySelector('.us-notif-error')?.remove();
                rowEl.insertAdjacentHTML('beforeend', '<span class="us-notif-error">Popup blocked — please allow popups for this site, then try again.</span>');
              }
            } else {
              slackOAuthPopup = popup;
            }
          }).catch(() => {
            if (btn && !signal.aborted) btn.textContent = 'Add to Slack';
          });
          return;
        }

        if (target.closest('#usConnectDiscord')) {
          const btn = target.closest<HTMLButtonElement>('#usConnectDiscord');
          if (discordOAuthPopup && !discordOAuthPopup.closed) {
            discordOAuthPopup.focus();
            return;
          }
          if (btn) btn.textContent = 'Connecting…';
          startDiscordOAuth().then((oauthUrl) => {
            if (signal.aborted) return;
            const popup = window.open(oauthUrl, 'discord-oauth', 'width=600,height=700,menubar=no,toolbar=no');
            if (!popup) {
              if (btn) btn.textContent = 'Connect Discord';
              const rowEl = btn?.closest<HTMLElement>('[data-channel-type="discord"]');
              if (rowEl) {
                rowEl.querySelector('.us-notif-error')?.remove();
                rowEl.insertAdjacentHTML('beforeend', '<span class="us-notif-error">Popup blocked — please allow popups for this site, then try again.</span>');
              }
            } else {
              discordOAuthPopup = popup;
            }
          }).catch(() => {
            if (btn && !signal.aborted) btn.textContent = 'Connect Discord';
          });
          return;
        }

        if (target.closest('#usConnectWebhook')) {
          const rowEl = target.closest<HTMLElement>('[data-channel-type="webhook"]');
          if (!rowEl) return;
          rowEl.querySelector('.us-notif-ch-actions')!.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:6px;width:100%">
              <input type="url" id="usWebhookUrl" placeholder="https://hooks.example.com/..." class="unified-settings-input" style="font-size:12px;width:100%">
              <input type="text" id="usWebhookLabel" placeholder="Label (optional)" class="unified-settings-input" style="font-size:12px;width:100%">
              <div style="display:flex;gap:6px">
                <button type="button" class="us-notif-ch-btn us-notif-ch-btn-primary" id="usWebhookSave">Save</button>
                <button type="button" class="us-notif-ch-btn" id="usWebhookCancel">Cancel</button>
              </div>
            </div>`;
          const urlInput = rowEl.querySelector<HTMLInputElement>('#usWebhookUrl');
          urlInput?.focus();
          return;
        }
        if (target.closest('#usWebhookSave')) {
          const urlInput = container.querySelector<HTMLInputElement>('#usWebhookUrl');
          const labelInput = container.querySelector<HTMLInputElement>('#usWebhookLabel');
          const url = urlInput?.value?.trim() ?? '';
          if (!url || !url.startsWith('https://')) {
            urlInput?.classList.add('us-notif-input-error');
            return;
          }
          const saveBtn = target.closest<HTMLButtonElement>('#usWebhookSave');
          if (saveBtn) saveBtn.textContent = 'Saving...';
          setWebhookChannel(url, labelInput?.value?.trim() || undefined).then(() => {
            if (!signal.aborted) { saveRuleWithNewChannel('webhook'); reloadNotifSection(); }
          }).catch(() => {
            if (saveBtn && !signal.aborted) saveBtn.textContent = 'Save';
          });
          return;
        }
        if (target.closest('#usWebhookCancel')) {
          reloadNotifSection();
          return;
        }

        if (target.closest('#usConnectWebPush')) {
          const btn = target.closest<HTMLButtonElement>('#usConnectWebPush');
          if (btn) {
            btn.disabled = true;
            btn.textContent = 'Requesting…';
          }
          (async () => {
            try {
              const { subscribeToPush, isWebPushSupported } = await import('@/services/push-notifications');
              if (!isWebPushSupported()) {
                if (btn) {
                  btn.disabled = false;
                  btn.textContent = 'Not supported';
                  btn.setAttribute('title', 'This browser (or in-app webview) does not support web push notifications.');
                }
                return;
              }
              await subscribeToPush();
              if (!signal.aborted) { saveRuleWithNewChannel('web_push'); reloadNotifSection(); }
            } catch (err) {
              console.warn('[notif] web_push subscribe failed:', err);
              if (btn && !signal.aborted) {
                btn.disabled = false;
                btn.textContent = 'Enable';
              }
            }
          })();
          return;
        }

        const disconnectBtn = target.closest<HTMLElement>('.us-notif-disconnect[data-channel]');
        if (disconnectBtn?.dataset.channel) {
          const channelType = disconnectBtn.dataset.channel as ChannelType;
          if (channelType === 'web_push') {
            // web_push needs two-sided cleanup: server row + browser
            // PushSubscription. unsubscribeFromPush calls both so the
            // user doesn't end up with a phantom browser subscription
            // after the Convex row is deleted.
            (async () => {
              try {
                const { unsubscribeFromPush } = await import('@/services/push-notifications');
                await unsubscribeFromPush();
              } catch (err) {
                console.warn('[notif] web_push unsubscribe failed:', err);
              } finally {
                if (!signal.aborted) reloadNotifSection();
              }
            })();
            return;
          }
          deleteChannel(channelType).then(() => {
            if (!signal.aborted) reloadNotifSection();
          }).catch(() => {});
          return;
        }
      }, { signal });

      const onMessage = (e: MessageEvent): void => {
        const trustedOrigin = e.origin === window.location.origin ||
          e.origin === 'https://worldmonitor.app' ||
          e.origin === 'https://www.worldmonitor.app' ||
          e.origin.endsWith('.worldmonitor.app');
        const fromSlack = slackOAuthPopup !== null && e.source === slackOAuthPopup;
        const fromDiscord = discordOAuthPopup !== null && e.source === discordOAuthPopup;
        if (!trustedOrigin || (!fromSlack && !fromDiscord)) return;
        if (e.data?.type === 'wm:slack_connected') {
          if (!signal.aborted) { saveRuleWithNewChannel('slack'); reloadNotifSection(); }
        } else if (e.data?.type === 'wm:slack_error') {
          const rowEl = container.querySelector<HTMLElement>('[data-channel-type="slack"]');
          if (rowEl) {
            rowEl.querySelector('.us-notif-error')?.remove();
            rowEl.insertAdjacentHTML('beforeend', `<span class="us-notif-error">Slack connection failed: ${escapeHtml(String(e.data.error ?? 'unknown'))}</span>`);
            const btn = rowEl.querySelector<HTMLButtonElement>('#usConnectSlack');
            if (btn) btn.textContent = 'Add to Slack';
          }
        } else if (e.data?.type === 'wm:discord_connected') {
          if (!signal.aborted) { saveRuleWithNewChannel('discord'); reloadNotifSection(); }
        } else if (e.data?.type === 'wm:discord_error') {
          const rowEl = container.querySelector<HTMLElement>('[data-channel-type="discord"]');
          if (rowEl) {
            rowEl.querySelector('.us-notif-error')?.remove();
            rowEl.insertAdjacentHTML('beforeend', `<span class="us-notif-error">Discord connection failed: ${escapeHtml(String(e.data.error ?? 'unknown'))}</span>`);
            const btn = rowEl.querySelector<HTMLButtonElement>('#usConnectDiscord');
            if (btn) btn.textContent = 'Connect Discord';
          }
        }
      };
      window.addEventListener('message', onMessage, { signal });

      return () => ac.abort();
    },
  };
}
