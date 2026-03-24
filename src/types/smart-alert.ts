/**
 * Smart Alert System Types
 *
 * Server-side alert system for keyword-based news notifications.
 * Supports Email and Telegram notification channels.
 */

/** Alert priority levels for filtering */
export type AlertPriority = 'CRITICAL' | 'HIGH' | 'NORMAL';

/** Supported notification channels */
export type NotificationChannel = 'email' | 'telegram';

/** Alert status for notification tracking */
export type NotificationStatus = 'pending' | 'sent' | 'failed';

/**
 * User Alert configuration stored in Redis
 */
export interface SmartAlert {
  /** Unique alert ID */
  id: string;
  /** User ID (anonymous or authenticated) */
  userId: string;
  /** Keyword to match against news */
  keyword: string;
  /** Priority levels to receive notifications for */
  priorityFilter: AlertPriority[];
  /** Notification channels to send to */
  channels: NotificationChannel[];
  /** Whether alert is active */
  isActive: boolean;
  /** Creation timestamp */
  createdAt: string;
  /** Last updated timestamp */
  updatedAt: string;
}

/**
 * User profile for notification delivery
 */
export interface AlertUserProfile {
  /** User ID */
  userId: string;
  /** Email address for notifications */
  email?: string;
  /** Telegram chat ID for notifications */
  telegramChatId?: string;
  /** Notification preferences */
  preferences: {
    /** Daily digest mode (batch notifications) */
    digestMode: boolean;
    /** Quiet hours (no notifications) */
    quietHoursStart?: number; // 0-23
    quietHoursEnd?: number; // 0-23
  };
}

/**
 * Notification record for tracking sent alerts
 */
export interface AlertNotification {
  /** Unique notification ID */
  id: string;
  /** Reference to the alert that triggered this */
  alertId: string;
  /** Reference to the news article */
  newsId: string;
  /** News title for display */
  newsTitle: string;
  /** News URL for linking */
  newsUrl: string;
  /** Determined priority of this notification */
  priority: AlertPriority;
  /** Channel used for this notification */
  channel: NotificationChannel;
  /** Delivery status */
  status: NotificationStatus;
  /** Timestamp when notification was created */
  createdAt: string;
  /** Timestamp when notification was sent (if successful) */
  sentAt?: string;
  /** Error message if failed */
  errorMessage?: string;
}

/**
 * News article structure for alert matching
 */
export interface AlertNewsItem {
  /** Article ID */
  id: string;
  /** Article title */
  title: string;
  /** Article content/summary */
  content?: string;
  /** Article URL */
  url: string;
  /** Source name */
  source: string;
  /** Tags/categories */
  tags: string[];
  /** Publication timestamp */
  publishedAt: string;
}

/**
 * Request body for creating an alert
 */
export interface CreateAlertRequest {
  /** Keyword to match */
  keyword: string;
  /** Priority levels to filter (defaults to all) */
  priorityFilter?: AlertPriority[];
  /** Notification channels (defaults to email) */
  channels?: NotificationChannel[];
  /** Email for notifications */
  email?: string;
  /** Telegram chat ID for notifications */
  telegramChatId?: string;
}

/**
 * Response body for alert operations
 */
export interface AlertResponse {
  /** Success flag */
  success: boolean;
  /** Alert data (for create/get) */
  alert?: SmartAlert;
  /** List of alerts (for list) */
  alerts?: SmartAlert[];
  /** Error message (if failed) */
  error?: string;
}

/**
 * Alert match result from matcher service
 */
export interface AlertMatch {
  /** Alert that matched */
  alert: SmartAlert;
  /** User profile for delivery */
  userProfile: AlertUserProfile;
  /** Determined priority */
  priority: AlertPriority;
  /** Matched keywords (could be multiple) */
  matchedKeywords: string[];
}

// Constants
export const SMART_ALERT_LIMITS = {
  /** Maximum alerts per user */
  MAX_ALERTS_PER_USER: 20,
  /** Maximum keyword length */
  MAX_KEYWORD_LENGTH: 100,
  /** Minimum keyword length */
  MIN_KEYWORD_LENGTH: 2,
  /** Rate limit: max notifications per alert per hour */
  NOTIFICATION_RATE_LIMIT: 1,
  /** Rate limit window in milliseconds */
  RATE_LIMIT_WINDOW_MS: 60 * 60 * 1000,
};
