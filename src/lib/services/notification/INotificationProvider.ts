/**
 * Notification Provider Interface
 * Documentation: documentation/backend/services/notifications.md
 */

// Re-export event types from central source of truth
export type { NotificationEvent } from '@/lib/constants/notification-events';

// Backend type — string-based, registry is the runtime source of truth
export type NotificationBackendType = string;

// Notification payload
export interface NotificationPayload {
  event: import('@/lib/constants/notification-events').NotificationEvent;
  requestId?: string;
  issueId?: string;
  title: string;
  author: string;
  userName: string;
  message?: string; // For error/issue events
  requestType?: string; // 'audiobook' | 'ebook' — drives type-specific titles via getEventTitle()
  timestamp: Date;
  recipientEmail?: string; // Set only for owner-targeted email notifications
}

// Provider config field definition for dynamic UI rendering
export interface ProviderConfigField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'select' | 'number';
  required: boolean;
  placeholder?: string;
  defaultValue?: string | number;
  options?: { label: string; value: string | number }[];
}

// Provider metadata for self-describing providers
export interface ProviderMetadata {
  type: string;
  displayName: string;
  description: string;
  iconLabel: string;
  iconColor: string;
  configFields: ProviderConfigField[];
}

export interface INotificationProvider {
  /** Provider identifier */
  type: string;

  /** Config field names that need encryption/masking */
  sensitiveFields: string[];

  /** Self-describing metadata for UI and validation */
  metadata: ProviderMetadata;

  /** Optional server-side validation performed before saving provider config */
  validateConfig?(config: Record<string, any>): void;

  /** Send notification with already-decrypted config */
  send(config: Record<string, any>, payload: NotificationPayload): Promise<void>;
}

export class NotificationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationConfigurationError';
  }
}
