/**
 * Component: SMTP Email Provider Tests
 * Documentation: documentation/backend/services/notifications.md
 */

import { describe, expect, it, vi } from 'vitest';

const smtpMocks = vi.hoisted(() => ({
  connectNet: vi.fn(),
  connectTls: vi.fn(),
  isIP: vi.fn(() => 0),
}));

vi.mock('node:net', () => ({ connect: smtpMocks.connectNet, isIP: smtpMocks.isIP }));
vi.mock('node:tls', () => ({ connect: smtpMocks.connectTls }));

describe('EmailProvider', () => {
  it('rejects invalid SMTP configuration before opening a connection', async () => {
    const { EmailProvider } = await import('@/lib/services/notification/providers/email.provider');
    const provider = new EmailProvider();

    await expect(provider.send(
      {
        host: 'smtp.example.com',
        port: 587,
        tlsMode: 'starttls',
        username: 'readmeabook',
        password: 'secret',
        fromEmail: 'readmeabook@example.com',
        systemRecipients: 'not-an-email',
      },
      {
        event: 'request_available',
        title: 'Test Book',
        author: 'Test Author',
        userName: 'Test User',
        timestamp: new Date(),
      }
    )).rejects.toThrow('Provide one or more valid email recipients');

    expect(smtpMocks.connectNet).not.toHaveBeenCalled();
    expect(smtpMocks.connectTls).not.toHaveBeenCalled();
  });

  it('marks SMTP credentials as sensitive for storage and masking', async () => {
    const { EmailProvider } = await import('@/lib/services/notification/providers/email.provider');
    const provider = new EmailProvider();

    expect(provider.sensitiveFields).toContain('password');
    expect(provider.metadata.configFields.some((field) => field.name === 'password' && field.required)).toBe(true);
  });
});
