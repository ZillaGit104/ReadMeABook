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
        emailEditable: true,
        emailBackendEnabled: true,
        preferences,
      }))
      .mockResolvedValueOnce(response({
        email: 'reader@example.com',
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

  it('hides notification categories until a local user adds an email', async () => {
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
        email: null,
        emailEditable: true,
        emailBackendEnabled: true,
        preferences,
      }))
      .mockResolvedValueOnce(response({ email: 'reader@example.com', preferences }));

    const { NotificationPreferencesSection } = await import(
      '@/components/profile/NotificationPreferencesSection'
    );
    render(<NotificationPreferencesSection />);

    expect(await screen.findByText(/Add an email address above/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Book is available' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'reader@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save email' }));

    expect(await screen.findByRole('checkbox', { name: 'Book is available' })).toBeInTheDocument();
  });
});
