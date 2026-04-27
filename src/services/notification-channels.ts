import { getClerkToken } from '@/services/clerk';
import { SITE_VARIANT } from '@/config/variant';

export type ChannelType = 'telegram' | 'slack' | 'email' | 'discord' | 'webhook' | 'web_push';
export type Sensitivity = 'all' | 'high' | 'critical';
export type QuietHoursOverride = 'critical_only' | 'silence_all' | 'batch_on_wake';
export type DigestMode = 'realtime' | 'daily' | 'twice_daily' | 'weekly';

export interface NotificationChannel {
  channelType: ChannelType;
  verified: boolean;
  linkedAt: number;
  chatId?: string;
  email?: string;
  slackChannelName?: string;
  slackTeamName?: string;
  slackConfigurationUrl?: string;
  webhookLabel?: string;
  // web_push identity fields
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  userAgent?: string;
}

export interface AlertRule {
  variant: string;
  enabled: boolean;
  eventTypes: string[];
  sensitivity: Sensitivity;
  channels: ChannelType[];
  quietHoursEnabled?: boolean;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimezone?: string;
  quietHoursOverride?: QuietHoursOverride;
  digestMode?: DigestMode;
  digestHour?: number;
  digestTimezone?: string;
  aiDigestEnabled?: boolean;
}

export interface ChannelsData {
  channels: NotificationChannel[];
  alertRules: AlertRule[];
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  let token = await getClerkToken();
  if (!token) {
    console.warn('[authFetch] getClerkToken returned null, retrying in 2s...');
    await new Promise((r) => setTimeout(r, 2000));
    token = await getClerkToken();
  }
  if (!token) throw new Error('Not authenticated (Clerk token null after retry)');
  return fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

export async function getChannelsData(): Promise<ChannelsData> {
  const res = await authFetch('/api/notification-channels');
  if (!res.ok) throw new Error(`get channels: ${res.status}`);
  return res.json() as Promise<ChannelsData>;
}

export async function createPairingToken(): Promise<{ token: string; expiresAt: number }> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create-pairing-token', variant: SITE_VARIANT }),
  });
  if (!res.ok) throw new Error(`create pairing token: ${res.status}`);
  return res.json();
}

export async function setEmailChannel(email: string): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-channel', channelType: 'email', email }),
  });
  if (!res.ok) throw new Error(`set email channel: ${res.status}`);
}

export async function setSlackChannel(webhookEnvelope: string): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-channel', channelType: 'slack', webhookEnvelope }),
  });
  if (!res.ok) throw new Error(`set slack channel: ${res.status}`);
}

export async function setWebhookChannel(webhookUrl: string, label?: string): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-channel', channelType: 'webhook', webhookEnvelope: webhookUrl, webhookLabel: label }),
  });
  if (!res.ok) throw new Error(`set webhook channel: ${res.status}`);
}

export async function startSlackOAuth(): Promise<string> {
  const res = await authFetch('/api/slack/oauth/start', { method: 'POST' });
  if (!res.ok) throw new Error(`slack oauth start: ${res.status}`);
  const data = await res.json() as { oauthUrl: string };
  return data.oauthUrl;
}

export async function startDiscordOAuth(): Promise<string> {
  const res = await authFetch('/api/discord/oauth/start', { method: 'POST' });
  if (!res.ok) throw new Error(`discord oauth start: ${res.status}`);
  const data = await res.json() as { oauthUrl: string };
  return data.oauthUrl;
}

export async function deleteChannel(channelType: ChannelType): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete-channel', channelType }),
  });
  if (!res.ok) throw new Error(`delete channel: ${res.status}`);
}

export async function saveAlertRules(rules: AlertRule): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-alert-rules', ...rules }),
  });
  if (!res.ok) throw new Error(`save alert rules: ${res.status}`);
}

export async function setQuietHours(settings: {
  variant: string;
  quietHoursEnabled: boolean;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimezone?: string;
  quietHoursOverride?: QuietHoursOverride;
}): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-quiet-hours', ...settings }),
  });
  if (!res.ok) throw new Error(`set quiet hours: ${res.status}`);
}

export async function setDigestSettings(settings: {
  variant: string;
  digestMode: DigestMode;
  digestHour?: number;
  digestTimezone?: string;
}): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-digest-settings', ...settings }),
  });
  if (!res.ok) throw new Error(`set digest settings: ${res.status}`);
}

/**
 * Thrown when the server rejects a (digestMode, sensitivity) pair as incompatible
 * — currently the (realtime, all) combination. UI catches this specifically to
 * render the helper text inline rather than surfacing a generic error.
 * See plans/forbid-realtime-all-events.md §1f.
 */
export class IncompatibleDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompatibleDeliveryError';
  }
}

/**
 * Atomic save of (digestMode, sensitivity) and any subset of the alert-rule /
 * digest-schedule fields. Used by the settings UI's delivery-mode change flow
 * — replaces the legacy two-call sequence (saveAlertRules + setDigestSettings)
 * which races against the cross-field validator on `daily+all → realtime`.
 */
export async function setNotificationConfig(args: {
  variant: string;
  enabled?: boolean;
  eventTypes?: string[];
  sensitivity?: Sensitivity;
  channels?: ChannelType[];
  aiDigestEnabled?: boolean;
  digestMode?: DigestMode;
  digestHour?: number;
  digestTimezone?: string;
}): Promise<void> {
  const res = await authFetch('/api/notification-channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-notification-config', ...args }),
  });
  if (res.ok) return;
  let body: { error?: string; message?: string } = {};
  try { body = await res.json(); } catch { /* keep default */ }
  if (res.status === 400 && body.error === 'INCOMPATIBLE_DELIVERY') {
    throw new IncompatibleDeliveryError(
      body.message ?? 'Real-time delivery requires High or Critical sensitivity.',
    );
  }
  throw new Error(`set notification config: ${res.status}`);
}
