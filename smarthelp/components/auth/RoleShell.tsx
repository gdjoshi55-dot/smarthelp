'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, Wrench } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import type { UserRole } from '@/lib/supabase';

const SECTION_LABELS: Record<string, string> = {
  home: 'Home',
  bookings: 'Bookings',
  wallet: 'Wallet',
  support: 'Support',
  favourites: 'Favourites',
  profile: 'Profile',
  jobs: 'Jobs',
  earnings: 'Earnings',
  kyc: 'Verification',
  availability: 'Availability',
  training: 'Training',
  dashboard: 'Dashboard',
  disputes: 'Disputes',
  customers: 'Customers',
  professionals: 'Professionals',
  payments: 'Payments',
  analytics: 'Analytics',
  audit: 'Audit log',
  services: 'Services',
  pricing: 'Pricing',
  categories: 'Categories',
  locations: 'Locations',
  staff: 'Staff',
  reports: 'Reports',
  promos: 'Promo codes',
};

/**
 * The sections that have a page behind them.
 *
 * `/api/auth/me` returns a section list derived from the role in the database,
 * which is why the nav can hold a tab whose page does not exist yet — a role can
 * be granted a section ahead of the work. Those render as `#`, the same as before
 * Phase 2; the ones with a real page are linked here rather than left dead, so
 * "Bookings" on the customer shell goes somewhere instead of nowhere.
 *
 * A section can be linked for one role and not another, hence a resolver that may
 * return `null`. `bookings` is customer-only in Phase 2: `/customer/bookings` is
 * the list of bookings *you* made, and building it for a professional would be a
 * different screen with a different question behind it. Pointing the other roles at
 * it produced a link to a 404, which is worse than a tab that was never drawn.
 */
const SECTION_HREFS: Record<
  string,
  (role: 'customer' | 'professional' | 'admin') => string | null
> = {
  bookings: (role) => (role === 'customer' ? '/customer/bookings' : null),
};

/**
 * The frame every role page sits in.
 *
 * The navigation is built from the `sections` array that `/api/auth/me`
 * returned, which is itself derived from the role in the database. So a role
 * cannot gain a tab by patching localStorage — the list is not the gate, the
 * Route Handlers are, but a tab that leads to a 403 is a worse experience than
 * a tab that was never drawn.
 */
export default function RoleShell({
  role,
  eyebrow,
  title,
  children,
}: {
  role: Extract<UserRole, 'customer' | 'professional' | 'admin'>;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  const { profile, roleLabel, sections, signOut, loading, initialising } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  if (initialising) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50" role="status" aria-busy="true">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  async function handleSignOut() {
    await signOut();
    router.replace('/login');
  }

  const nav = (sections.length ? sections : ['home']).map((section) => {
    const resolved = SECTION_HREFS[section]?.(role) ?? null;
    // The home tab is the shell root for the role; every other linked tab is its
    // own path, matched by prefix so `/customer/bookings/<id>` still counts as
    // being in Bookings.
    const href = resolved ?? (section === 'home' ? `/${role === 'admin' ? 'admin' : role}` : null);
    const current =
      href != null &&
      (href === pathname || pathname === `${href}/` || pathname.startsWith(`${href}/`));
    return { key: section, label: SECTION_LABELS[section] ?? section, href, current };
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-3 focus:rounded-lg focus:bg-blue-600 focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-2.5">
              <div className="inline-flex items-center justify-center w-9 h-9 bg-blue-600 rounded-xl">
                <Wrench className="h-5 w-5 text-white" aria-hidden="true" />
              </div>
              <div>
                <p className="font-semibold text-gray-900 leading-tight">SmartHelp</p>
                <p className="text-xs text-gray-500 leading-tight">{roleLabel ?? eyebrow}</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="hidden sm:block text-right">
                <p className="text-sm font-medium text-gray-900">
                  {profile?.full_name ?? 'Account'}
                </p>
                <p className="text-xs text-gray-500">{profile?.phone ?? profile?.email ?? ''}</p>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                disabled={loading}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 hover:text-gray-900 px-3 py-2 rounded-lg hover:bg-gray-100 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col lg:flex-row gap-8">
        <nav aria-label="Sections" className="lg:w-56 shrink-0">
          <ul className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0 -mx-1 px-1">
            {nav.map((item) => (
              <li key={item.key} className="shrink-0">
                <Link
                  href={item.href ?? '#'}
                  aria-current={item.current ? 'page' : undefined}
                  className={`block px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${
                    item.current
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <main id="main" className="flex-1 min-w-0">
          <div className="mb-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">{eyebrow}</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">{title}</h1>
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
