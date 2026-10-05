'use client';

import React, { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { ROLE_HOME, can, type Capability } from '@/lib/roles';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import type { UserRole } from '@/lib/supabase';

/**
 * The one place a page decides whether it may render.
 *
 * While the session probe is in flight nothing renders — a redirect fired
 * before the session is known bounces a signed-in user to `/login`, which is
 * the kind of bug that only shows up on a slow connection. So: wait, then
 * decide.
 *
 * `role` may be a list, because the staff shell is deliberately shared: admin,
 * ops, support and super_admin all live at `/admin`, so a single-role guard
 * there would send ops and support to `/admin` — the page they are already on,
 * forever.
 */
export default function AuthGuard({
  children,
  role,
  capability,
}: {
  children: React.ReactNode;
  role?: UserRole | readonly UserRole[];
  capability?: Capability;
}) {
  const { session, role: currentRole, initialising } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [redirecting, setRedirecting] = useState(false);

  const allowedKey = Array.isArray(role) ? role.join(',') : (role ?? '');
  const roleOk = allowedKey
    ? !!currentRole && (Array.isArray(role) ? role : [role as UserRole]).includes(currentRole)
    : true;

  useEffect(() => {
    if (initialising || redirecting) return;

    if (!session) {
      setRedirecting(true);
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }
    if (allowedKey && currentRole && !roleOk) {
      // A user in the wrong shell is sent to their own, not to a 403. They did
      // nothing wrong; they followed a link meant for somebody else.
      const home = ROLE_HOME[currentRole] ?? '/';
      // Guard against a redirect to the page we are already on, which would
      // otherwise spin forever.
      if (home === pathname) return;
      setRedirecting(true);
      router.replace(home);
    }
  }, [initialising, session, currentRole, allowedKey, roleOk, router, pathname, redirecting]);

  if (initialising || redirecting || !session) {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-gray-50"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="text-center">
          <LoadingSpinner size="lg" />
          <p className="mt-4 text-gray-500 text-sm font-medium">Loading SmartHelp…</p>
        </div>
      </div>
    );
  }

  if (allowedKey && !roleOk) {
    // The redirect is in flight. Rendering nothing is better than a flash of
    // the wrong dashboard.
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-gray-50"
        role="status"
        aria-live="polite"
      >
        <div className="text-center">
          <LoadingSpinner size="lg" />
          <p className="mt-4 text-gray-500 text-sm font-medium">Loading SmartHelp…</p>
        </div>
      </div>
    );
  }

  if (capability && !can(currentRole, capability)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md text-center bg-white rounded-2xl border border-gray-200 p-8">
          <h1 className="text-lg font-semibold text-gray-900">Not available to your role</h1>
          <p className="mt-2 text-sm text-gray-600">
            This area needs a permission your account does not have. If that looks wrong, ask an
            administrator to check your role.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
