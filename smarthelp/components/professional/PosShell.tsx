'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

/** The sections a professional can reach from any job screen. */
const PRO_SECTIONS = [
  { label: 'Home', href: '/professional' },
  { label: 'Jobs', href: '/professional/jobs' },
  { label: 'Earnings', href: '/professional/earnings' },
  { label: 'Availability', href: '/professional/availability' },
  { label: 'Verification', href: '/professional/kyc' },
];

/**
 * pos-subscription's full page, lifted onto the professional screens.
 *
 * This is the `/subscription` screen layout verbatim: a `min-h-screen`
 * `from-blue-600 to-blue-800` gradient, the centered white icon chip with a
 * blue glyph, the bold white title and muted-blue subtitle, white
 * `rounded-2xl shadow-xl` content, and the bottom row of light-blue links with
 * the page's Sign out. The shell takes no sidebar and no gray page — the job
 * screens have the same relationship to the blue page that the subscription
 * cards do to theirs.
 */
export function PosShell({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const { signOut, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  async function handleSignOut() {
    await signOut();
    router.replace('/login');
  }

  const current = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-600 to-blue-800 p-4 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 text-center">
          <div className="mx-auto inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-white shadow-lg">
            <Icon className="h-8 w-8 text-blue-600" aria-hidden="true" />
          </div>
          <h1 className="mt-3 text-3xl font-bold text-white">{title}</h1>
          <p className="mt-1 text-blue-100">{subtitle}</p>
        </div>

        {children}

        <nav aria-label="Sections" className="mt-6 text-center">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            {PRO_SECTIONS.map(({ label, href }) =>
              current(href) ? (
                <span key={href} className="text-sm font-semibold text-white">
                  {label}
                </span>
              ) : (
                <Link
                  key={href}
                  href={href}
                  className="rounded text-sm font-medium text-blue-100 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2"
                >
                  {label}
                </Link>
              )
            )}
            <button
              type="button"
              onClick={handleSignOut}
              disabled={loading}
              className="rounded text-sm font-medium text-blue-100 hover:text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2"
            >
              Sign out
            </button>
          </div>
        </nav>
      </div>
    </div>
  );
}