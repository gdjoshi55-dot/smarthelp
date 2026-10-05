'use client';

import { useMemo, useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import AuthGuard from '@/components/auth/AuthGuard';
import RoleShell from '@/components/auth/RoleShell';
import { useAuth } from '@/contexts/AuthContext';
import type { UserRole } from '@/lib/supabase';

const STAFF_ROLES: readonly UserRole[] = ['admin', 'ops', 'support', 'super_admin'];

export default function AdminHome() {
  const { profile, roleLabel, sections, hasCapability } = useAuth();
  const [marketplaceLive, setMarketplaceLive] = useState(true);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }, []);

  const isSuperAdmin = profile?.role === 'super_admin';

  return (
    // One shell for the whole staff team: admin, ops, support and super_admin
    // all land here, and the sections each one sees come from its own row.
    <AuthGuard role={STAFF_ROLES}>
      <RoleShell role="admin" eyebrow={roleLabel ?? 'Operations'} title={`${greeting}, ${profile?.full_name ?? 'there'}`}>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <section className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900">Phase 0 foundation</h2>
              <p className="mt-1 text-sm text-gray-600">
                Sign-in works for every role. The operational sections below unlock as their phases
                land.
              </p>

              <div className="mt-5 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">Operational areas available in Phase 0</caption>
                  <thead>
                    <tr className="border-b border-gray-200 text-left">
                      <th scope="col" className="py-2 pr-4 font-medium text-gray-500">Area</th>
                      <th scope="col" className="py-2 pr-4 font-medium text-gray-500">Status</th>
                      <th scope="col" className="py-2 font-medium text-gray-500">Phase</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {sections.map((section) => (
                      <tr key={section}>
                        <td className="py-2.5 pr-4 capitalize text-gray-900">{section}</td>
                        <td className="py-2.5 pr-4">
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                            <BadgeCheck className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
                            Permission granted
                          </span>
                        </td>
                        <td className="py-2.5 text-gray-500">Later</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <div className="space-y-6">
            <section className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900">Your access</h2>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Role</dt>
                  <dd className="font-medium text-gray-900 capitalize">{profile?.role}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Status</dt>
                  <dd className="font-medium text-gray-900 capitalize">{profile?.status}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Sections</dt>
                  <dd className="font-medium text-gray-900 tabular-nums">{sections.length}</dd>
                </div>
              </dl>
            </section>

            {isSuperAdmin ? (
              <section className="bg-white border border-gray-200 rounded-xl p-6">
                <h2 className="text-base font-semibold text-gray-900">Marketplace</h2>
                <p className="mt-1 text-sm text-gray-600">
                  Turning this off hides booking from customers. Professionals keep their existing jobs.
                </p>
                <label className="mt-4 flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={marketplaceLive}
                    onChange={(e) => setMarketplaceLive(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-700">
                    Marketplace {marketplaceLive ? 'live' : 'paused'}
                  </span>
                </label>
                <p className="mt-2 text-xs text-gray-500">
                  Phase 0 is a local toggle. It is not wired to the platform settings table yet.
                </p>
              </section>
            ) : (
              <section className="bg-white border border-gray-200 rounded-xl p-6">
                <h2 className="text-base font-semibold text-gray-900">Restricted areas</h2>
                <p className="mt-1 text-sm text-gray-600">
                  {hasCapability('role.manage')
                    ? 'You can manage staff accounts and platform settings.'
                    : 'Platform settings and staff management are limited to administrators.'}
                </p>
              </section>
            )}
          </div>
        </div>
      </RoleShell>
    </AuthGuard>
  );
}
