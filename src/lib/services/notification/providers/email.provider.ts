/**
 * Component: SMTP Email Notification Provider
 * Documentation: documentation/backend/services/notifications.md
 */

import { connect as connectNet, isIP, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import {
  INotificationProvider,
  NotificationConfigurationError,
  NotificationPayload,
  ProviderMetadata,
} from '../INotificationProvider';
import { getEventMeta, getEventTitle } from '@/lib/constants/notification-events';

type SmtpSocket = Socket | TLSSocket;

interface SmtpConfig {
  host: string;
  port: number | string;
  tlsMode: 'starttls' | 'implicit';
  username: string;
  password: string;
  fromEmail: string;
  fromName?: string;
  systemRecipients: string;
}

interface SmtpResponse {
  code: number;
  lines: string[];
}

class SmtpSession {
  private socket: SmtpSocket;
  private buffer = '';
  private lines: string[] = [];
  private waiters: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
  private socketError: Error | null = null;
  private readonly onData = (chunk: Buffer | string) => {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      this.lines.push(this.buffer.slice(0, newlineIndex).replace(/\r$/, ''));
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.flushWaiters();
      newlineIndex = this.buffer.indexOf('\n');
    }
  };
  private readonly onError = (error: Error) => {
    this.socketError = error;
    this.flushWaiters();
  };

  constructor(socket: SmtpSocket) {
    this.socket = socket;
    this.attach();
  }

  private attach(): void {
    this.socket.setTimeout(30_000);
    this.socket.on('timeout', () => this.socket.destroy(new Error('SMTP connection timed out')));
    this.socket.on('data', this.onData);
    this.socket.on('error', this.onError);
    this.socket.on('close', () => {
      if (!this.socketError) this.onError(new Error('SMTP connection closed unexpectedly'));
    });
  }

  private detach(): void {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
  }

  private flushWaiters(): void {
    while (this.waiters.length > 0 && (this.lines.length > 0 || this.socketError)) {
      const waiter = this.waiters.shift()!;
      if (this.lines.length > 0) waiter.resolve(this.lines.shift()!);
      else waiter.reject(this.socketError!);
    }
  }

  private readLine(): Promise<string> {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    if (this.socketError) return Promise.reject(this.socketError);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async readResponse(): Promise<SmtpResponse> {
    const lines: string[] = [];
    let code = 0;

    do {
      const line = await this.readLine();
      const match = line.match(/^(\d{3})([- ])(.*)$/);
      if (!match) throw new Error(`Invalid SMTP response: ${line}`);
      code = Number(match[1]);
      lines.push(line);
      if (match[2] === ' ') break;
    } while (true);

    return { code, lines };
  }

  async command(command: string, acceptedCodes: number[]): Promise<SmtpResponse> {
    this.socket.write(`${command}\r\n`);
    return this.readAcceptedResponse(acceptedCodes);
  }

  async readAcceptedResponse(acceptedCodes: number[]): Promise<SmtpResponse> {
    const response = await this.readResponse();
    if (!acceptedCodes.includes(response.code)) {
      throw new Error(`SMTP command failed (${response.code}): ${response.lines.join(' ')}`);
    }
    return response;
  }

  async upgradeToTls(host: string): Promise<void> {
    this.detach();
    this.socket.pause();
    const secureSocket = connectTls({
      socket: this.socket,
      ...(isIP(host) === 0 && { servername: host }),
      rejectUnauthorized: true,
    });
    await new Promise<void>((resolve, reject) => {
      secureSocket.once('secureConnect', resolve);
      secureSocket.once('error', reject);
    });
    this.socket = secureSocket;
    this.socketError = null;
    this.buffer = '';
    this.lines = [];
    this.attach();
  }

  writeData(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (error) => error ? reject(error) : resolve());
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email);
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function parseRecipients(value: string): string[] {
  const recipients = value.split(',').map((recipient) => recipient.trim()).filter(Boolean);
  if (recipients.length === 0 || recipients.some((recipient) => !isValidEmail(recipient))) {
    throw new Error('Provide one or more valid email recipients');
  }
  const uniqueRecipients = new Map<string, string>();
  for (const recipient of recipients) {
    const key = recipient.toLowerCase();
    if (!uniqueRecipients.has(key)) uniqueRecipients.set(key, recipient);
  }
  return Array.from(uniqueRecipients.values());
}

function toSmtpConfig(config: Record<string, any>): SmtpConfig {
  const result = config as SmtpConfig;
  const port = Number(result.port);
  if (!result.host?.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NotificationConfigurationError('SMTP host and a valid port are required');
  }
  if (!['starttls', 'implicit'].includes(result.tlsMode)) {
    throw new NotificationConfigurationError('Select STARTTLS or implicit TLS for SMTP');
  }
  if (!result.username || !result.password || !isValidEmail(result.fromEmail || '')) {
    throw new NotificationConfigurationError('SMTP username, password, and a valid sender email are required');
  }
  try {
    parseRecipients(result.systemRecipients || '');
  } catch (error) {
    throw new NotificationConfigurationError(error instanceof Error ? error.message : 'Invalid system recipients');
  }
  return { ...result, port };
}

async function openSession(config: SmtpConfig): Promise<SmtpSession> {
  const host = config.host.trim();
  const port = Number(config.port);
  if (config.tlsMode === 'implicit') {
    const socket = connectTls({ host, port, ...(isIP(host) === 0 && { servername: host }), rejectUnauthorized: true });
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    return new SmtpSession(socket);
  }

  const socket = connectNet({ host, port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return new SmtpSession(socket);
}

export class EmailProvider implements INotificationProvider {
  type = 'email' as const;
  sensitiveFields = ['password'];
  metadata: ProviderMetadata = {
    type: 'email',
    displayName: 'Email (SMTP)',
    description: 'Send system and per-user notifications using an SMTP server',
    iconLabel: '@',
    iconColor: 'bg-emerald-600',
    configFields: [
      { name: 'host', label: 'SMTP Host', type: 'text', required: true, placeholder: 'smtp.example.com' },
      { name: 'port', label: 'SMTP Port', type: 'number', required: true, defaultValue: 587 },
      {
        name: 'tlsMode',
        label: 'TLS Mode',
        type: 'select',
        required: true,
        defaultValue: 'starttls',
        options: [
          { label: 'STARTTLS (typically port 587)', value: 'starttls' },
          { label: 'Implicit TLS (typically port 465)', value: 'implicit' },
        ],
      },
      { name: 'username', label: 'SMTP Username', type: 'text', required: true },
      { name: 'password', label: 'SMTP Password', type: 'password', required: true },
      { name: 'fromEmail', label: 'Sender Email', type: 'text', required: true, placeholder: 'readmeabook@example.com' },
      { name: 'fromName', label: 'Sender Name', type: 'text', required: false, defaultValue: 'ReadMeABook' },
      { name: 'systemRecipients', label: 'System Alert Recipients', type: 'text', required: true, placeholder: 'admin@example.com, ops@example.com' },
    ],
  };

  validateConfig(config: Record<string, any>): void {
    toSmtpConfig(config);
  }

  async send(config: Record<string, any>, payload: NotificationPayload): Promise<void> {
    const smtp = toSmtpConfig(config);
    const recipients = payload.recipientEmail
      ? parseRecipients(payload.recipientEmail)
      : parseRecipients(smtp.systemRecipients);
    const session = await openSession(smtp);

    try {
      const greeting = await session.readResponse();
      if (greeting.code !== 220) throw new Error(`SMTP greeting failed: ${greeting.lines.join(' ')}`);

      let hello = await session.command('EHLO readmeabook.local', [250]);
      if (smtp.tlsMode === 'starttls') {
        if (!hello.lines.some((line) => /\bSTARTTLS\b/i.test(line))) {
          throw new Error('SMTP server does not advertise STARTTLS');
        }
        await session.command('STARTTLS', [220]);
        await session.upgradeToTls(smtp.host.trim());
        hello = await session.command('EHLO readmeabook.local', [250]);
      }

      const authLine = hello.lines.find((line) => /^\d{3}[- ]AUTH(?:[ =])/i.test(line));
      const authMechanisms = authLine?.replace(/^\d{3}[- ]AUTH[ =]+/i, '').toUpperCase().split(/\s+/) ?? [];
      if (authMechanisms.includes('LOGIN')) {
        await session.command('AUTH LOGIN', [334]);
        await session.command(Buffer.from(smtp.username, 'utf8').toString('base64'), [334]);
        await session.command(Buffer.from(smtp.password, 'utf8').toString('base64'), [235]);
      } else if (authMechanisms.includes('PLAIN')) {
        const credentials = Buffer.from(`\0${smtp.username}\0${smtp.password}`, 'utf8').toString('base64');
        const response = await session.command(`AUTH PLAIN ${credentials}`, [235, 334]);
        if (response.code === 334) await session.command(credentials, [235]);
      } else {
        throw new Error('SMTP server does not advertise authentication');
      }
      await session.command(`MAIL FROM:<${smtp.fromEmail}>`, [250]);
      for (const recipient of recipients) {
        await session.command(`RCPT TO:<${recipient}>`, [250, 251]);
      }
      await session.command('DATA', [354]);
      await session.writeData(`${this.formatMessage(smtp, payload, recipients)}\r\n.\r\n`);
      await session.readAcceptedResponse([250]);
      await session.command('QUIT', [221]);
    } finally {
      session.close();
    }
  }

  private formatMessage(config: SmtpConfig, payload: NotificationPayload, recipients: string[]): string {
    const meta = getEventMeta(payload.event);
    const subject = getEventTitle(payload.event, payload.requestType);
    const fromName = config.fromName?.trim() || 'ReadMeABook';
    const isIssue = payload.event === 'issue_reported';
    const lines = [
      `${meta.emoji} ${subject}`,
      '',
      `Title: ${payload.title}`,
      `Author: ${payload.author}`,
      `${isIssue ? 'Reported by' : 'Requested by'}: ${payload.userName}`,
    ];
    if (payload.issueId) lines.push(`Issue ID: ${payload.issueId}`);
    else if (payload.requestId) lines.push(`Request ID: ${payload.requestId}`);
    if (payload.message) {
      lines.push(`${meta.messageLabel ?? 'Details'}: ${payload.message}`);
    }

    const body = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
    const toHeader = payload.recipientEmail
      ? recipients[0]
      : recipients.join(', ');
    return [
      `From: ${encodeHeader(fromName)} <${config.fromEmail}>`,
      `To: ${toHeader}`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ].join('\r\n');
  }
}
