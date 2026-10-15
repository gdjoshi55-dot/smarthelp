'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { MapPin, Phone, Mail, CalendarDays } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import { useAuth } from '@/contexts/AuthContext';
import { ProfileApiError, updateMe } from '@/lib/profileClient';
import { fetchAddresses, type SavedAddress } from '@/lib/addressClient';

const LOCALES: { value: string; label: string }[] = [
  { value: 'en-IN', label: 'English' },
  { value: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { value: 'ta-IN', label: 'தமிழ் (Tamil)' },
  { value: 'te-IN', label: 'తెలుగు (Telugu)' },
  { value: 'ml-IN', label: 'മലയാളം (Malayalam)' },
  { value: 'kn-IN', label: 'ಕನ್ನಡ (Kannada)' },
  { value: 'mr-IN', label: 'मराठी (Marathi)' },
];

function ProfileManager() {
  const { profile, customer, refreshProfile } = useAuth();

  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [email, setEmail] = useState(profile?.email ?? '');
  const [locale, setLocale] = useState(profile?.locale ?? 'en-IN');
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [addresses, setAddresses] = useState<SavedAddress[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAddresses()
      .then((res) => {
        if (!cancelled) setAddresses(res.addresses);
      })
      .catch(() => {
        if (!cancelled) setAddresses([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFieldErrors({});
    setSaving(true);
    try {
      const patch: { full_name?: string; email?: string; locale?: string } = {};
      if (fullName.trim() !== (profile?.full_name ?? '')) patch.full_name = fullName.trim();
      if (email.trim() !== (profile?.email ?? '')) patch.email = email.trim();
      if (locale !== (profile?.locale ?? 'en-IN')) patch.locale = locale;

      if (Object.keys(patch).length === 0) {
        toast('Nothing has changed.');
        return;
      }

      await updateMe(patch);
      await refreshProfile();
      toast.success('Profile updated.');
    } catch (error) {
      if (error instanceof ProfileApiError) {
        if (error.fields) setFieldErrors(error.fields);
        toast.error(error.message);
      } else {
        toast.error('We could not save your profile. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-6">
        <section className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-base font-semibold text-gray-900">Account details</h2>
          <p className="mt-1 text-sm text-gray-600">
            Your name and email appear on invoices and booking updates.
          </p>

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div>
              <label htmlFor="full_name" className="block text-sm font-medium text-gray-700">
                Full name
              </label>
              <input
                id="full_name"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                autoComplete="name"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              {fieldErrors.full_name ? (
                <p className="mt-1 text-xs text-red-600">{fieldErrors.full_name}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              {fieldErrors.email ? (
                <p className="mt-1 text-xs text-red-600">{fieldErrors.email}</p>
              ) : null}
            </div>

            <div>
              <label htmlFor="locale" className="block text-sm font-medium text-gray-700">
                Preferred language
              </label>
              <select
                id="locale"
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {LOCALES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </form>
        </section>

        <section className="bg-white border border-gray-200 rounded-xl p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">Saved addresses</h2>
            <a
              href="/customer/checkout"
              className="text-sm font-medium text-blue-700 hover:underline"
            >
              Add at checkout
            </a>
          </div>
          {addresses === null ? (
            <div className="mt-4 flex justify-center">
              <LoadingSpinner size="sm" />
            </div>
          ) : addresses.length === 0 ? (
            <p className="mt-2 text-sm text-gray-600">
              No saved addresses yet. You add one while booking a service.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {addresses.map((address) => (
                <li key={address.id} className="flex items-start gap-3">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {address.label}
                      {address.isDefault ? (
                        <span className="ml-2 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                          Default
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-gray-500">{address.formatted}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="space-y-6">
        <section className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-base font-semibold text-gray-900">Contact</h2>
          <ul className="mt-3 space-y-3 text-sm text-gray-700">
            <li className="flex items-center gap-2.5">
              <Phone className="h-4 w-4 text-gray-400" aria-hidden="true" />
              {profile?.phone ?? 'No phone on file'}
            </li>
            <li className="flex items-center gap-2.5">
              <Mail className="h-4 w-4 text-gray-400" aria-hidden="true" />
              {profile?.email ?? '—'}
            </li>
            <li className="flex items-center gap-2.5">
              <CalendarDays className="h-4 w-4 text-gray-400" aria-hidden="true" />
              Member since{' '}
              {profile?.created_at
                ? new Date(profile.created_at).toLocaleDateString('en-IN', {
                    month: 'long',
                    year: 'numeric',
                  })
                : '—'}
            </li>
          </ul>
          <p className="mt-3 text-xs text-gray-500">
            To change your phone number, contact support — it is verified by SMS.
          </p>
        </section>

        <section className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-base font-semibold text-gray-900">Your referral code</h2>
          <p className="mt-2 font-mono text-lg font-semibold text-blue-700">
            {customer?.referral_code ?? '—'}
          </p>
          <p className="mt-2 text-xs text-gray-500">
            Share it with a neighbour. When they complete a booking, you both get ₹100.
          </p>
        </section>
      </div>
    </div>
  );
}

export default function CustomerProfilePage() {
  return (
    <AuthGuard role="customer">
      <RoleShell role="customer" eyebrow="Customer" title="Profile">
        <ProfileManager />
      </RoleShell>
    </AuthGuard>
  );
}
