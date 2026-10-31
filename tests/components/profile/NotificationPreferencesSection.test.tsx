/**
 * Component: Profile Notification Preferences Tests
 * Documentation: documentation/backend/services/notifications.md
 */

// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/utils/api', () => ({ fetchWithAuth: fetchWithAuthMock }));

const response = (data: unknown) => ({
  ok: true,
  json: async () => data,
});

describe('NotificationPreferencesSection', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
  });

  it('loads per-user email preferences and persists changes', async () => {
    const preferences = {
      notifyRequestPendingApproval: false,
      notifyRequestApproved: false,
      notifyRequestGrabbed: false,
      notifyRequestAvailable: true,
      notifyRequestError: false,
      notifyRequestCancelled: false,
    };
    fetchWithAuthMock
      .mockResolvedValueOnce(response({
        email: 'reader@example.com',
        emailBackendEnabled: true,
        preferences,
      }))
      .mockResolvedValueOnce(response({
        preferences: { ...preferences, notifyRequestError: true },
      }));

    const { NotificationPreferencesSection } = await import(
      '@/components/profile/NotificationPreferencesSection'
    );
    render(<NotificationPreferencesSection />);

    const availableToggle = await screen.findByRole('checkbox', { name: 'Book is available' });
    expect(availableToggle).toBeChecked();
    expect(screen.getByText('Notifications are sent to reader@example.com.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Request or download fails' }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenNthCalledWith(
        2,
        '/api/user/notification-preferences',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ notifyRequestError: true }),
        })
      );
    });
  });
});
