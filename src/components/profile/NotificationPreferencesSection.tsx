/**
 * Component: Profile Notification Preferences
 * Documentation: documentation/backend/services/notifications.md
 */

'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { fetchWithAuth } from '@/lib/utils/api';

const preferenceOptions = [
  { key: 'notifyRequestPendingApproval', label: 'Request is awaiting approval' },
  { key: 'notifyRequestApproved', label: 'Request is approved' },
  { key: 'notifyRequestGrabbed', label: 'Download starts' },
  { key: 'notifyRequestAvailable', label: 'Book is available' },
  { key: 'notifyRequestError', label: 'Request or download fails' },
  { key: 'notifyRequestCancelled', label: 'Request is cancelled' },
] as const;

type PreferenceKey = (typeof preferenceOptions)[number]['key'];
type Preferences = Record<PreferenceKey, boolean>;

const defaultPreferences: Preferences = {
  notifyRequestPendingApproval: false,
  notifyRequestApproved: false,
  notifyRequestGrabbed: false,
  notifyRequestAvailable: true,
  notifyRequestError: false,
  notifyRequestCancelled: false,
};

export function NotificationPreferencesSection() {
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [email, setEmail] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [emailEditable, setEmailEditable] = useState(false);
  const [emailBackendEnabled, setEmailBackendEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    fetchWithAuth('/api/user/notification-preferences')
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to load notification preferences');
        return response.json();
      })
      .then((data) => {
        if (!active) return;
        setEmail(data.email || null);
        setEmailDraft(data.email || '');
        setEmailEditable(Boolean(data.emailEditable));
        setEmailBackendEnabled(Boolean(data.emailBackendEnabled));
        setPreferences({ ...defaultPreferences, ...data.preferences });
      })
      .catch((loadError) => {
        if (active) {
          setLoadFailed(true);
          setError(loadError instanceof Error ? loadError.message : 'Failed to load preferences');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const updatePreference = async (key: PreferenceKey, enabled: boolean) => {
    const previous = preferences;
    setPreferences({ ...previous, [key]: enabled });
    setSaving(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/user/notification-preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: enabled }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Failed to save notification preference');
      setPreferences({ ...previous, ...result.preferences });
    } catch (saveError) {
      setPreferences(previous);
      setError(saveError instanceof Error ? saveError.message : 'Failed to save notification preference');
    } finally {
      setSaving(false);
    }
  };

  const saveEmail = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/user/notification-preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailDraft.trim() }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || result.error || 'Failed to save email');
      setEmail(result.email || null);
      setEmailDraft(result.email || '');
      setPreferences({ ...defaultPreferences, ...result.preferences });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save email');
    } finally {
      setSaving(false);
    }
  };

  let introText = 'An email address is required to receive personal request alerts.';
  if (email) {
    introText = 'Choose which updates you receive for your requests.';
  } else if (emailEditable) {
    introText = 'Add an email address below to enable personal request alerts and choose which updates to receive.';
  }

  return (
    <section>
      <div className="mb-5">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">Email Notifications</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {introText}
        </p>
      </div>

      <div className="rounded-2xl overflow-hidden bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700/50 shadow-sm">
        <div className="p-6 space-y-4">
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
              {error}
            </p>
          )}

          {!loading && !loadFailed && emailEditable && (
            <form onSubmit={saveEmail} className="space-y-2">
              <label htmlFor="notification-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Email address
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  id="notification-email"
                  type="email"
                  autoComplete="email"
                  value={emailDraft}
                  onChange={(event) => setEmailDraft(event.target.value)}
                  placeholder="you@example.com"
                  className="min-w-0 flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-gray-900 dark:text-white"
                  aria-label="Email address"
                />
                <button
                  type="submit"
                  disabled={saving || emailDraft.trim() === (email || '')}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save email'}
                </button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                An email address enables personal notifications about your requests. Leave it blank to disable personal email alerts.
              </p>
            </form>
          )}

          {!loading && !loadFailed && email && (
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Notifications are sent to {email}.
              {!emailBackendEnabled && ' Email delivery is currently not configured by the administrator.'}
            </p>
          )}

          {!loading && !loadFailed && !email && !emailEditable && (
            <p className="text-sm text-gray-600 dark:text-gray-300">
              No email address is associated with this account, so personal email alerts are unavailable.
            </p>
          )}

          {loading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading preferences...</p>
          ) : loadFailed ? null : email ? (
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {preferenceOptions.map(({ key, label }) => (
                <label key={key} className="flex items-center justify-between gap-4 py-3">
                  <span className="text-sm text-gray-800 dark:text-gray-200">{label}</span>
                  <input
                    type="checkbox"
                    checked={preferences[key]}
                    disabled={saving || loading || loadFailed}
                    onChange={(event) => updatePreference(key, event.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    aria-label={label}
                  />
                </label>
              ))}
            </div>
          ) : emailEditable ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Add an email address above to configure your request notification preferences.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
