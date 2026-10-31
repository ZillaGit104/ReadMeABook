/**
 * Component: Notification Service
 * Documentation: documentation/backend/services/notifications.md
 */

import { getEncryptionService } from '../encryption.service';
import { RMABLogger } from '../../utils/logger';
import { prisma } from '../../db';
import { INotificationProvider, NotificationPayload, ProviderMetadata } from './INotificationProvider';
import { AppriseProvider } from './providers/apprise.provider';
import { DiscordProvider } from './providers/discord.provider';
import { EmailProvider } from './providers/email.provider';
import { NtfyProvider } from './providers/ntfy.provider';
import { PushoverProvider } from './providers/pushover.provider';
import type { NotificationEvent } from '@/lib/constants/notification-events';

const logger = RMABLogger.create('NotificationService');

// Provider registry
const providers = new Map<string, INotificationProvider>();

export function registerProvider(provider: INotificationProvider): void {
  providers.set(provider.type, provider);
}

export function getProvider(type: string): INotificationProvider | undefined {
  return providers.get(type);
}

// Register built-in providers
registerProvider(new AppriseProvider());
registerProvider(new DiscordProvider());
registerProvider(new EmailProvider());
registerProvider(new NtfyProvider());
registerProvider(new PushoverProvider());

type UserEmailPreference =
  | 'notifyRequestPendingApproval'
  | 'notifyRequestApproved'
  | 'notifyRequestGrabbed'
  | 'notifyRequestAvailable'
  | 'notifyRequestError'
  | 'notifyRequestCancelled';

const USER_EMAIL_PREFERENCES: Partial<Record<NotificationEvent, UserEmailPreference>> = {
  request_pending_approval: 'notifyRequestPendingApproval',
  request_approved: 'notifyRequestApproved',
  request_grabbed: 'notifyRequestGrabbed',
  request_available: 'notifyRequestAvailable',
  request_error: 'notifyRequestError',
  request_cancelled: 'notifyRequestCancelled',
};

type NotificationBackend = Awaited<ReturnType<typeof prisma.notificationBackend.findMany>>[number];

export function getRegisteredProviderTypes(): string[] {
  return Array.from(providers.keys());
}

export function getAllProviderMetadata(): ProviderMetadata[] {
  return Array.from(providers.values()).map((p) => p.metadata);
}

export class NotificationService {
  private encryptionService = getEncryptionService();

  /**
   * Send to system backends subscribed to the event and, when opted in,
   * to the owner of the associated request through enabled email backends.
   */
  async sendNotification(payload: NotificationPayload): Promise<void> {
    try {
      const backends = await prisma.notificationBackend.findMany({
        where: {
          enabled: true,
          events: {
            array_contains: payload.event,
          },
        },
      });

      let ownerDelivery: { backend: NotificationBackend; payload: NotificationPayload }[] = [];
      try {
        ownerDelivery = await this.getOwnerEmailDelivery(payload);
      } catch (error) {
        logger.error('Failed to resolve owner email notification', {
          error: error instanceof Error ? error.message : String(error),
          event: payload.event,
          requestId: payload.requestId,
        });
      }
      const deliveries = [
        ...backends.map((backend) => ({ backend, payload })),
        ...ownerDelivery,
      ];

      if (deliveries.length === 0) {
        logger.debug(`No backends subscribed to event: ${payload.event}`);
        return;
      }

      logger.info(`Sending notification to ${deliveries.length} recipient(s)`, {
        event: payload.event,
        requestId: payload.requestId,
      });

      const results = await Promise.allSettled(
        deliveries.map(({ backend, payload: deliveryPayload }) =>
          this.sendToBackend(backend.type, backend.config, deliveryPayload)
        )
      );

      const successful = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;

      logger.info(`Notification sent: ${successful} succeeded, ${failed} failed`, {
        event: payload.event,
        requestId: payload.requestId,
      });

      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.error(`Failed to send to backend ${deliveries[index].backend.name}`, {
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            backend: deliveries[index].backend.type,
          });
        }
      });
    } catch (error) {
      logger.error('Failed to send notifications', {
        error: error instanceof Error ? error.message : String(error),
        event: payload.event,
        requestId: payload.requestId,
      });
      // Don't throw - non-blocking
    }
  }

  private async getOwnerEmailDelivery(
    payload: NotificationPayload
  ): Promise<{ backend: NotificationBackend; payload: NotificationPayload }[]> {
    const preference = USER_EMAIL_PREFERENCES[payload.event];
    if (!payload.requestId || !preference) return [];

    const request = await prisma.request.findUnique({
      where: { id: payload.requestId },
      select: {
        user: {
          select: {
            plexEmail: true,
            notifyRequestPendingApproval: true,
            notifyRequestApproved: true,
            notifyRequestGrabbed: true,
            notifyRequestAvailable: true,
            notifyRequestError: true,
            notifyRequestCancelled: true,
          },
        },
      },
    });

    const owner = request?.user;
    const recipientEmail = owner?.plexEmail?.trim();
    if (!owner || !recipientEmail || !owner[preference]) return [];

    const emailBackends = await prisma.notificationBackend.findMany({
      where: { type: 'email', enabled: true },
    });

    return emailBackends
      .filter((backend) => {
        const config = backend.config;
        const configuredRecipients = config && typeof config === 'object' && !Array.isArray(config)
          ? config.systemRecipients
          : undefined;
        const systemRecipients = typeof configuredRecipients === 'string'
          ? configuredRecipients.split(',').map((recipient) => recipient.trim().toLowerCase())
          : [];
        return !systemRecipients.includes(recipientEmail.toLowerCase());
      })
      .map((backend) => ({
        backend,
        payload: { ...payload, recipientEmail },
      }));
  }

  /**
   * Route notification to type-specific provider
   */
  async sendToBackend(
    type: string,
    config: any,
    payload: NotificationPayload
  ): Promise<void> {
    const provider = getProvider(type);
    if (!provider) {
      throw new Error(`Unsupported backend type: ${type}`);
    }

    const decryptedConfig = this.decryptConfig(provider.sensitiveFields, config);
    return provider.send(decryptedConfig, payload);
  }

  /**
   * Encrypt sensitive config values before saving
   */
  encryptConfig(type: string, config: any): any {
    const provider = getProvider(type);
    if (!provider) {
      return { ...config };
    }

    const encrypted = { ...config };
    for (const field of provider.sensitiveFields) {
      if (encrypted[field] && !this.encryptionService.isEncryptedFormat(encrypted[field])) {
        encrypted[field] = this.encryptionService.encrypt(encrypted[field]);
      }
    }
    return encrypted;
  }

  /**
   * Mask sensitive config values for API responses
   */
  maskConfig(type: string, config: any): any {
    const provider = getProvider(type);
    if (!provider) {
      return { ...config };
    }

    const masked = { ...config };
    for (const field of provider.sensitiveFields) {
      if (masked[field]) {
        masked[field] = '••••••••';
      }
    }
    return masked;
  }

  /**
   * Re-encrypt any sensitive fields that were stored as plaintext due to
   * the isEncrypted() false-positive bug (URLs with exactly 2 colons).
   * Safe to call multiple times — skips already-encrypted values.
   */
  async reEncryptUnprotectedBackends(): Promise<number> {
    let fixed = 0;

    try {
      const backends = await prisma.notificationBackend.findMany();

      for (const backend of backends) {
        const provider = getProvider(backend.type);
        if (!provider) continue;

        const config = backend.config as any;
        let needsUpdate = false;
        const updatedConfig = { ...config };

        for (const field of provider.sensitiveFields) {
          if (updatedConfig[field] && !this.encryptionService.isEncryptedFormat(updatedConfig[field])) {
            updatedConfig[field] = this.encryptionService.encrypt(updatedConfig[field]);
            needsUpdate = true;
          }
        }

        if (needsUpdate) {
          await prisma.notificationBackend.update({
            where: { id: backend.id },
            data: { config: updatedConfig },
          });
          fixed++;
          logger.info(`Re-encrypted plaintext sensitive fields for backend: ${backend.name}`);
        }
      }

      if (fixed > 0) {
        logger.warn(`Re-encrypted ${fixed} backend(s) with unprotected sensitive fields`);
      }
    } catch (error) {
      logger.error('Failed to re-encrypt backends', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return fixed;
  }

  /**
   * Decrypt sensitive config values
   */
  private decryptConfig(sensitiveFields: string[], config: any): any {
    const decrypted = { ...config };
    for (const field of sensitiveFields) {
      if (decrypted[field] && this.encryptionService.isEncryptedFormat(decrypted[field])) {
        decrypted[field] = this.encryptionService.decrypt(decrypted[field]);
      }
    }
    return decrypted;
  }
}

// Singleton instance
let notificationService: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  if (!notificationService) {
    notificationService = new NotificationService();
  }
  return notificationService;
}
