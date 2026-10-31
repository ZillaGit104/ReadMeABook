/**
 * Component: Notification Service Tests
 * Documentation: documentation/backend/services/notifications.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
prismaMock.notificationBackend = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
} as any;

const encryptionMock = vi.hoisted(() => ({
  encrypt: vi.fn((value: string) => `enc:${value}`),
  decrypt: vi.fn((value: string) => value.replace('enc:', '')),
  isEncryptedFormat: vi.fn((value: string) => typeof value === 'string' && value.startsWith('enc:')),
}));

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));

vi.mock('@/lib/services/encryption.service', () => ({
  getEncryptionService: () => encryptionMock,
}));

describe('getEventTitle', () => {
  it('returns type-specific title when requestType matches titleByRequestType', async () => {
    const { getEventTitle } = await import('@/lib/constants/notification-events');
    expect(getEventTitle('request_available', 'audiobook')).toBe('Audiobook Available');
    expect(getEventTitle('request_available', 'ebook')).toBe('Ebook Available');
  });

  it('returns default title when requestType is not provided', async () => {
    const { getEventTitle } = await import('@/lib/constants/notification-events');
    expect(getEventTitle('request_available')).toBe('Request Available');
    expect(getEventTitle('request_available', undefined)).toBe('Request Available');
  });

  it('returns default title when requestType does not match any entry', async () => {
    const { getEventTitle } = await import('@/lib/constants/notification-events');
    expect(getEventTitle('request_available', 'podcast')).toBe('Request Available');
  });

  it('returns default title for events without titleByRequestType', async () => {
    const { getEventTitle } = await import('@/lib/constants/notification-events');
    expect(getEventTitle('request_approved', 'audiobook')).toBe('Request Approved');
    expect(getEventTitle('request_error')).toBe('Request Error');
    expect(getEventTitle('request_pending_approval')).toBe('New Request Pending Approval');
  });
});

describe('NotificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  describe('sendNotification', () => {
    it('sends notifications to all enabled backends subscribed to the event', async () => {
      prismaMock.notificationBackend.findMany.mockResolvedValue([
        {
          id: '1',
          type: 'discord',
          name: 'Discord - Admins',
          config: { webhookUrl: 'https://discord.com/webhook1' },
          events: ['request_approved', 'request_available'],
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: '2',
          type: 'pushover',
          name: 'Pushover - Users',
          config: { userKey: 'user123', appToken: 'app456' },
          events: ['request_approved'],
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      await service.sendNotification({
        event: 'request_approved',
        requestId: 'req-1',
        title: 'Test Book',
        author: 'Test Author',
        userName: 'Test User',
        timestamp: new Date(),
      });

      expect(prismaMock.notificationBackend.findMany).toHaveBeenCalledWith({
        where: {
          enabled: true,
          events: { array_contains: 'request_approved' },
        },
      });

      // Should send to both backends
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not send if no backends are subscribed to the event', async () => {
      prismaMock.notificationBackend.findMany.mockResolvedValue([]);

      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      await service.sendNotification({
        event: 'request_approved',
        requestId: 'req-1',
        title: 'Test Book',
        author: 'Test Author',
        userName: 'Test User',
        timestamp: new Date(),
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends an opted-in request email only to its owner', async () => {
      const emailBackend = {
        id: 'email-1',
        type: 'email',
        name: 'Email',
        config: { systemRecipients: 'admin@example.com' },
        events: [],
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      prismaMock.notificationBackend.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([emailBackend]);
      prismaMock.request.findUnique.mockResolvedValue({
        user: {
          plexEmail: 'reader@example.com',
          notifyRequestPendingApproval: false,
          notifyRequestApproved: false,
          notifyRequestGrabbed: false,
          notifyRequestAvailable: true,
          notifyRequestError: false,
          notifyRequestCancelled: false,
        },
      });

      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();
      const sendSpy = vi.spyOn(service, 'sendToBackend').mockResolvedValue(undefined);

      await service.sendNotification({
        event: 'request_available',
        requestId: 'req-1',
        title: 'Test Book',
        author: 'Test Author',
        userName: 'Test User',
        timestamp: new Date(),
      });

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith(
        'email',
        emailBackend.config,
        expect.objectContaining({ recipientEmail: 'reader@example.com' })
      );
    });

    it('does not send per-user email after the owner opts out', async () => {
      prismaMock.notificationBackend.findMany.mockResolvedValue([]);
      prismaMock.request.findUnique.mockResolvedValue({
        user: {
          plexEmail: 'reader@example.com',
          notifyRequestPendingApproval: false,
          notifyRequestApproved: false,
          notifyRequestGrabbed: false,
          notifyRequestAvailable: false,
          notifyRequestError: false,
          notifyRequestCancelled: false,
        },
      });

      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();
      const sendSpy = vi.spyOn(service, 'sendToBackend').mockResolvedValue(undefined);

      await service.sendNotification({
        event: 'request_available',
        requestId: 'req-1',
        title: 'Test Book',
        author: 'Test Author',
        userName: 'Test User',
        timestamp: new Date(),
      });

      expect(sendSpy).not.toHaveBeenCalled();
      expect(prismaMock.notificationBackend.findMany).toHaveBeenCalledTimes(1);
    });

    it('continues sending to other backends if one fails', async () => {
      prismaMock.notificationBackend.findMany.mockResolvedValue([
        {
          id: '1',
          type: 'discord',
          name: 'Discord - Admins',
          config: { webhookUrl: 'https://discord.com/webhook1' },
          events: ['request_approved'],
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: '2',
          type: 'pushover',
          name: 'Pushover - Users',
          config: { userKey: 'user123', appToken: 'app456' },
          events: ['request_approved'],
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      // First backend fails, second succeeds
      fetchMock
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true }),
        });

      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      await service.sendNotification({
        event: 'request_approved',
        requestId: 'req-1',
        title: 'Test Book',
        author: 'Test Author',
        userName: 'Test User',
        timestamp: new Date(),
      });

      // Should still attempt both
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('sendToBackend', () => {
    it('routes to Discord provider and decrypts config', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      await service.sendToBackend(
        'discord',
        { webhookUrl: 'enc:https://discord.com/webhook', username: 'ReadMeABook' },
        {
          event: 'request_approved',
          requestId: 'req-1',
          title: 'Test Book',
          author: 'Test Author',
          userName: 'Test User',
          timestamp: new Date('2024-01-01T00:00:00Z'),
        }
      );

      expect(encryptionMock.decrypt).toHaveBeenCalledWith('enc:https://discord.com/webhook');
      expect(fetchMock).toHaveBeenCalled();

      const fetchCall = fetchMock.mock.calls[0];
      // Decrypted URL should be used
      expect(fetchCall[0]).toBe('https://discord.com/webhook');
    });

    it('routes to Pushover provider and decrypts config', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 1 }),
      });

      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      await service.sendToBackend(
        'pushover',
        { userKey: 'enc:user123', appToken: 'enc:app456', priority: 1 },
        {
          event: 'request_approved',
          requestId: 'req-1',
          title: 'Test Book',
          author: 'Test Author',
          userName: 'Test User',
          timestamp: new Date(),
        }
      );

      expect(encryptionMock.decrypt).toHaveBeenCalledWith('enc:user123');
      expect(encryptionMock.decrypt).toHaveBeenCalledWith('enc:app456');
      expect(fetchMock).toHaveBeenCalled();
    });

    it('throws error for unsupported backend type', async () => {
      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      await expect(
        service.sendToBackend(
          'email',
          {},
          {
            event: 'request_approved',
            requestId: 'req-1',
            title: 'Test Book',
            author: 'Test Author',
            userName: 'Test User',
            timestamp: new Date(),
          }
        )
      ).rejects.toThrow('Unsupported backend type: email');
    });
  });

  describe('DiscordProvider', () => {
    it('sends Discord webhook with rich embed', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const { DiscordProvider } = await import('@/lib/services/notification');
      const provider = new DiscordProvider();

      await provider.send(
        {
          webhookUrl: 'https://discord.com/webhook',
          username: 'ReadMeABook',
        },
        {
          event: 'request_approved',
          requestId: 'req-1',
          title: 'Test Book',
          author: 'Test Author',
          userName: 'Test User',
          timestamp: new Date('2024-01-01T00:00:00Z'),
        }
      );

      expect(fetchMock).toHaveBeenCalled();

      const fetchCall = fetchMock.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);

      expect(fetchCall[0]).toBe('https://discord.com/webhook');
      expect(fetchCall[1].method).toBe('POST');
      expect(fetchCall[1].headers['Content-Type']).toBe('application/json');
      expect(body.username).toBe('ReadMeABook');
      expect(body.embeds).toHaveLength(1);
      expect(body.embeds[0].title).toBe('✅ Request Approved');
      expect(body.embeds[0].color).toBe(2278750); // Green for approved (0x22C55E)
    });

    it('uses type-specific title for request_available with requestType', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const { DiscordProvider } = await import('@/lib/services/notification');
      const provider = new DiscordProvider();

      // Test audiobook
      await provider.send(
        { webhookUrl: 'https://discord.com/webhook' },
        {
          event: 'request_available',
          requestId: 'req-1',
          title: 'Test Book',
          author: 'Test Author',
          userName: 'Test User',
          requestType: 'audiobook',
          timestamp: new Date('2024-01-01T00:00:00Z'),
        }
      );

      let body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.embeds[0].title).toBe('\u{1F389} Audiobook Available');

      // Test ebook
      fetchMock.mockClear();
      await provider.send(
        { webhookUrl: 'https://discord.com/webhook' },
        {
          event: 'request_available',
          requestId: 'req-2',
          title: 'Test Book 2',
          author: 'Test Author 2',
          userName: 'Test User',
          requestType: 'ebook',
          timestamp: new Date('2024-01-01T00:00:00Z'),
        }
      );

      body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.embeds[0].title).toBe('\u{1F389} Ebook Available');

      // Test fallback (no requestType)
      fetchMock.mockClear();
      await provider.send(
        { webhookUrl: 'https://discord.com/webhook' },
        {
          event: 'request_available',
          requestId: 'req-3',
          title: 'Test Book 3',
          author: 'Test Author 3',
          userName: 'Test User',
          timestamp: new Date('2024-01-01T00:00:00Z'),
        }
      );

      body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.embeds[0].title).toBe('\u{1F389} Request Available');
    });

    it('uses default username if not provided', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const { DiscordProvider } = await import('@/lib/services/notification');
      const provider = new DiscordProvider();

      await provider.send(
        {
          webhookUrl: 'https://discord.com/webhook',
        },
        {
          event: 'request_approved',
          requestId: 'req-1',
          title: 'Test Book',
          author: 'Test Author',
          userName: 'Test User',
          timestamp: new Date(),
        }
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.username).toBe('ReadMeABook');
    });

    it('throws error if Discord API returns non-OK response', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'Bad Request',
      });

      const { DiscordProvider } = await import('@/lib/services/notification');
      const provider = new DiscordProvider();

      await expect(
        provider.send(
          { webhookUrl: 'https://discord.com/webhook' },
          {
            event: 'request_approved',
            requestId: 'req-1',
            title: 'Test Book',
            author: 'Test Author',
            userName: 'Test User',
            timestamp: new Date(),
          }
        )
      ).rejects.toThrow('Discord webhook failed: 400 Bad Request');
    });
  });

  describe('PushoverProvider', () => {
    it('sends Pushover notification with correct payload', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 1 }),
      });

      const { PushoverProvider } = await import('@/lib/services/notification');
      const provider = new PushoverProvider();

      await provider.send(
        {
          userKey: 'user123',
          appToken: 'app456',
          priority: 1,
        },
        {
          event: 'request_approved',
          requestId: 'req-1',
          title: 'Test Book',
          author: 'Test Author',
          userName: 'Test User',
          timestamp: new Date(),
        }
      );

      expect(fetchMock).toHaveBeenCalled();

      const fetchCall = fetchMock.mock.calls[0];

      expect(fetchCall[0]).toBe('https://api.pushover.net/1/messages.json');
      expect(fetchCall[1].method).toBe('POST');
      expect(fetchCall[1].headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      const body = fetchCall[1].body;
      // Body should be URL-encoded string
      expect(typeof body).toBe('string');
      expect(body).toContain('priority=1');
    });

    it('uses default priority if not provided', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 1 }),
      });

      const { PushoverProvider } = await import('@/lib/services/notification');
      const provider = new PushoverProvider();

      await provider.send(
        {
          userKey: 'user123',
          appToken: 'app456',
        },
        {
          event: 'request_approved',
          requestId: 'req-1',
          title: 'Test Book',
          author: 'Test Author',
          userName: 'Test User',
          timestamp: new Date(),
        }
      );

      const body = fetchMock.mock.calls[0][1].body;
      expect(body.toString()).toContain('priority=0');
    });

    it('throws error if Pushover API returns non-OK response', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'invalid user key',
      });

      const { PushoverProvider } = await import('@/lib/services/notification');
      const provider = new PushoverProvider();

      await expect(
        provider.send(
          { userKey: 'user123', appToken: 'app456' },
          {
            event: 'request_approved',
            requestId: 'req-1',
            title: 'Test Book',
            author: 'Test Author',
            userName: 'Test User',
            timestamp: new Date(),
          }
        )
      ).rejects.toThrow();
    });
  });

  describe('encryptConfig', () => {
    it('encrypts sensitive Discord config values', async () => {
      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      const encrypted = service.encryptConfig('discord', {
        webhookUrl: 'https://discord.com/webhook',
        username: 'ReadMeABook',
      });

      expect(encryptionMock.encrypt).toHaveBeenCalledWith('https://discord.com/webhook');
      expect(encrypted.webhookUrl).toBe('enc:https://discord.com/webhook');
      expect(encrypted.username).toBe('ReadMeABook'); // Not encrypted
    });

    it('encrypts sensitive Pushover config values', async () => {
      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      const encrypted = service.encryptConfig('pushover', {
        userKey: 'user123',
        appToken: 'app456',
        priority: 1,
      });

      expect(encryptionMock.encrypt).toHaveBeenCalledWith('user123');
      expect(encryptionMock.encrypt).toHaveBeenCalledWith('app456');
      expect(encrypted.userKey).toBe('enc:user123');
      expect(encrypted.appToken).toBe('enc:app456');
      expect(encrypted.priority).toBe(1); // Not encrypted
    });

    it('encrypts the SMTP password', async () => {
      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      const encrypted = service.encryptConfig('email', {
        password: 'smtp-secret',
        host: 'smtp.example.com',
      });

      expect(encrypted.password).toBe('enc:smtp-secret');
      expect(encrypted.host).toBe('smtp.example.com');
    });
  });

  describe('getRegisteredProviderTypes', () => {
    it('returns all registered provider type keys', async () => {
      const { getRegisteredProviderTypes } = await import('@/lib/services/notification');
      const types = getRegisteredProviderTypes();

      expect(types).toContain('apprise');
      expect(types).toContain('discord');
      expect(types).toContain('ntfy');
      expect(types).toContain('pushover');
      expect(types).toContain('email');
      expect(types).toHaveLength(5);
    });
  });

  describe('getAllProviderMetadata', () => {
    it('returns metadata for all registered providers', async () => {
      const { getAllProviderMetadata } = await import('@/lib/services/notification');
      const metadata = getAllProviderMetadata();

      expect(metadata).toHaveLength(5);

      const apprise = metadata.find((m) => m.type === 'apprise');
      expect(apprise).toBeDefined();
      expect(apprise!.displayName).toBe('Apprise');
      expect(apprise!.iconLabel).toBe('A');
      expect(apprise!.iconColor).toBe('bg-purple-500');

      const discord = metadata.find((m) => m.type === 'discord');
      expect(discord).toBeDefined();
      expect(discord!.displayName).toBe('Discord');
      expect(discord!.iconLabel).toBe('D');
      expect(discord!.iconColor).toBe('bg-indigo-500');
      expect(discord!.configFields.length).toBeGreaterThan(0);

      const ntfy = metadata.find((m) => m.type === 'ntfy');
      expect(ntfy).toBeDefined();
      expect(ntfy!.displayName).toBe('ntfy');
      expect(ntfy!.iconLabel).toBe('N');

      const pushover = metadata.find((m) => m.type === 'pushover');
      expect(pushover).toBeDefined();
      expect(pushover!.displayName).toBe('Pushover');
      expect(pushover!.iconLabel).toBe('P');

      const email = metadata.find((m) => m.type === 'email');
      expect(email).toBeDefined();
      expect(email!.displayName).toBe('Email (SMTP)');
      expect(email!.configFields.find((field) => field.name === 'password')?.type).toBe('password');
    });

    it('includes config field definitions with correct properties', async () => {
      const { getAllProviderMetadata } = await import('@/lib/services/notification');
      const metadata = getAllProviderMetadata();

      const discord = metadata.find((m) => m.type === 'discord')!;
      const webhookField = discord.configFields.find((f) => f.name === 'webhookUrl');
      expect(webhookField).toBeDefined();
      expect(webhookField!.required).toBe(true);
      expect(webhookField!.type).toBe('text');

      const pushover = metadata.find((m) => m.type === 'pushover')!;
      const priorityField = pushover.configFields.find((f) => f.name === 'priority');
      expect(priorityField).toBeDefined();
      expect(priorityField!.type).toBe('select');
      expect(priorityField!.options).toBeDefined();
      expect(priorityField!.options!.length).toBe(5);
    });
  });

  describe('reEncryptUnprotectedBackends', () => {
    it('re-encrypts plaintext sensitive fields stored due to isEncrypted bug', async () => {
      // Simulate a backend with a Telegram URL stored as plaintext (the bug)
      prismaMock.notificationBackend.findMany.mockResolvedValue([
        {
          id: 'backend-1',
          type: 'apprise',
          name: 'Telegram via Apprise',
          config: {
            serverUrl: 'http://apprise:8000',
            urls: 'tgram://1234567890:PLPe1Hh-VhbRC3MoT5QngwkPHoMTD/-100181291455/',
          },
          events: ['request_available'],
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      prismaMock.notificationBackend.update.mockResolvedValue({} as any);

      // Mock isEncryptedFormat to return false for the plaintext URL
      encryptionMock.isEncryptedFormat.mockImplementation(
        (value: string) => typeof value === 'string' && value.startsWith('enc:')
      );

      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      const fixed = await service.reEncryptUnprotectedBackends();

      expect(fixed).toBe(1);
      expect(encryptionMock.encrypt).toHaveBeenCalledWith(
        'tgram://1234567890:PLPe1Hh-VhbRC3MoT5QngwkPHoMTD/-100181291455/'
      );
      expect(prismaMock.notificationBackend.update).toHaveBeenCalledWith({
        where: { id: 'backend-1' },
        data: {
          config: {
            serverUrl: 'http://apprise:8000',
            urls: 'enc:tgram://1234567890:PLPe1Hh-VhbRC3MoT5QngwkPHoMTD/-100181291455/',
          },
        },
      });
    });

    it('skips backends with already-encrypted fields', async () => {
      prismaMock.notificationBackend.findMany.mockResolvedValue([
        {
          id: 'backend-1',
          type: 'discord',
          name: 'Discord',
          config: { webhookUrl: 'enc:https://discord.com/webhook', username: 'Bot' },
          events: ['request_available'],
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      encryptionMock.isEncryptedFormat.mockImplementation(
        (value: string) => typeof value === 'string' && value.startsWith('enc:')
      );

      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      const fixed = await service.reEncryptUnprotectedBackends();

      expect(fixed).toBe(0);
      expect(prismaMock.notificationBackend.update).not.toHaveBeenCalled();
    });

    it('returns 0 when no backends exist', async () => {
      prismaMock.notificationBackend.findMany.mockResolvedValue([]);

      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      const fixed = await service.reEncryptUnprotectedBackends();

      expect(fixed).toBe(0);
    });
  });

  describe('maskConfig', () => {
    it('masks sensitive Discord config values', async () => {
      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      const masked = service.maskConfig('discord', {
        webhookUrl: 'https://discord.com/webhook/very/long/url',
        username: 'ReadMeABook',
      });

      expect(masked.webhookUrl).toBe('••••••••');
      expect(masked.username).toBe('ReadMeABook'); // Not masked
    });

    it('masks sensitive Pushover config values', async () => {
      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      const masked = service.maskConfig('pushover', {
        userKey: 'user123',
        appToken: 'app456',
        priority: 1,
      });

      expect(masked.userKey).toBe('••••••••');
      expect(masked.appToken).toBe('••••••••');
      expect(masked.priority).toBe(1); // Not masked
    });

    it('masks the SMTP password', async () => {
      const { NotificationService } = await import('@/lib/services/notification');
      const service = new NotificationService();

      const masked = service.maskConfig('email', {
        password: 'enc:smtp-secret',
        host: 'smtp.example.com',
      });

      expect(masked.password).toBe('••••••••');
      expect(masked.host).toBe('smtp.example.com');
    });
  });
});
