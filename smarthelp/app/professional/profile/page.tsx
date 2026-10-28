'use client';

import { useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { BadgeCheck, CalendarDays, Mail, Phone, Star } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import { useAuth } from '@/contexts/AuthContext';
import { ProfileApiError, updateMe } from '@/lib/profileClient';
import { VERIFICATION_COPY } from '@/components/professional/verificationCopy';
import ProfessionalAddressSection from '@/components/professional/ProfessionalAddressSection';

const LOCALES: { value: string; label: string }[] = [
  { value: 'en-IN', label: 'English' },
  { value: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { value: 'ta-IN', label: 'தமிழ் (Tamil)' },
  { value: 'te-IN', label: 'తెలుగు (Telugu)' },
  { value: 'ml-IN', label: 'മലയാളം (Malayalam)' },
  { value: 'kn-IN', label: 'ಕನ್ನಡ (Kannada)' },
  { value: 'mr-IN', label: 'मराठी (Marathi)' },
];

const TRAINING_COPY: Record<string, { label: string; tone: string }> = {
  not_started: { label: 'Not started', tone: 'bg-gray-100 text-gray-700' },
  in_progress: { label: 'In progress', tone: 'bg-amber-100 text-amber-800' },
  completed: { label: 'Completed', tone: 'bg-green-100 text-green-800' },
};

function ProfessionalProfileManager() {
  const { profile, professional, refreshProfile } = useAuth();

  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [email, setEmail] = useState(profile?.email ?? '');
  const [locale, setLocale] = useState(profile?.locale ?? 'en-IN');
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const verification = VERIFICATION_COPY[professional?.verification_status ?? 'not_submitted'];
  const training = TRAINING_COPY[professional?.training_status ?? 'not_started'];

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
            Customers see your name and rating. Your contact details stay private.
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
          <h2 className="text-base font-semibold text-gray-900">Working status</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-gray-600">Verification</dt>
              <dd>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${verification.tone}`}>
                  {verification.label}
                </span>
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-600">Training</dt>
              <dd>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${training.tone}`}>
                  {training.label}
                </span>
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-600">Availability</dt>
              <dd className="text-gray-900">
                {professional?.availability_status === 'online' ? 'Online' : 'Offline'}
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            <Link href="/professional/kyc" className="font-semibold text-blue-600 hover:text-blue-700">
              Manage verification
            </Link>
            <Link
              href="/professional/training"
              className="font-semibold text-blue-600 hover:text-blue-700"
            >
              Training
            </Link>
            <Link
              href="/professional/availability"
              className="font-semibold text-blue-600 hover:text-blue-700"
            >
              Availability
            </Link>
          </div>
        </section>

        <ProfessionalAddressSection />
      </div>

      <div className="space-y-6">
        <section className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="text-base font-semibold text-gray-900">Your rating</h2>
          <p className="mt-2 flex items-center gap-1.5 text-2xl font-semibold text-gray-900">
            <Star className="h-5 w-5 text-amber-400" aria-hidden="true" />
            {professional?.rating ? professional.rating.toFixed(1) : '—'}
            <span className="text-sm font-normal text-gray-500">
              ({professional?.rating_count ?? 0} reviews)
            </span>
          </p>
        </section>

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
        </section>

        {professional?.verification_status === 'verified' ? (
          <section className="flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 p-5">
            <BadgeCheck className="mt-0.5 h-5 w-5 shrink-0 text-green-600" aria-hidden="true" />
            <p className="text-sm text-green-900">
              You are verified. Customers can see your profile and book you.
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export default function ProfessionalProfilePage() {
  return (
    <AuthGuard role="professional">
      <RoleShell role="professional" eyebrow="Professional" title="Profile">
        <ProfessionalProfileManager />
      </RoleShell>
    </AuthGuard>
  );
}
