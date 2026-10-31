/**
 * Component: User Notification Preferences API Tests
 * Documentation: documentation/backend/services/notifications.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

let authRequest: any;
const prismaMock = createPrismaMock();
const requireAuthMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/middleware/auth', () => ({ requireAuth: requireAuthMock }));

describe('User notification preferences API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authRequest = { user: { id: 'user-1' }, json: vi.fn() };
    requireAuthMock.mockImplementation((_request: any, handler: any) => handler(authRequest));
  });

  it('returns the authenticated user preferences and email backend status', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      plexEmail: 'reader@example.com',
      notifyRequestPendingApproval: false,
      notifyRequestApproved: false,
      notifyRequestGrabbed: false,
      notifyRequestAvailable: true,
      notifyRequestError: false,
      notifyRequestCancelled: false,
    });
    prismaMock.notificationBackend.findFirst.mockResolvedValue({ id: 'email-1' });

    const { GET } = await import('@/app/api/user/notification-preferences/route');
    const response = await GET({} as any);
    const body = await response.json();

    expect(body.email).toBe('reader@example.com');
    expect(body.emailBackendEnabled).toBe(true);
    expect(body.preferences.notifyRequestAvailable).toBe(true);
  });

  it('updates only preferences belonging to the authenticated user', async () => {
    const preferences = { notifyRequestError: true };
    authRequest.json.mockResolvedValue(preferences);
    prismaMock.user.update.mockResolvedValue(preferences);

    const { PUT } = await import('@/app/api/user/notification-preferences/route');
    const response = await PUT({} as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: preferences,
      select: expect.any(Object),
    });
    expect(body.preferences).toEqual(preferences);
  });

  it('rejects non-boolean or unknown preference fields', async () => {
    authRequest.json.mockResolvedValue({ notifyRequestAvailable: 'yes', role: 'admin' });

    const { PUT } = await import('@/app/api/user/notification-preferences/route');
    const response = await PUT({} as any);

    expect(response.status).toBe(400);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});
