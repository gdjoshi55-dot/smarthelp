'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wrench } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { ROLE_HOME } from '@/lib/roles';

/**
 * The public chrome (§20.1): a sticky white bar, the wordmark, three links and
 * the two buttons that decide whether somebody is a customer or a professional.
 *
 * The "Get help" button goes to the catalogue rather than to sign-up, because
 * somebody who has not decided to trust us yet is not ready to give us a phone
 * number. Signing in is one click away from every screen, which is the only
 * moment it belongs.
 *
 * It reads the session from the existing auth context rather than asking the
 * server again: the header renders inside a layout that already has it, and a
 * public page that had to fetch `/api/auth/me` to decide whether to show "Log
 * in" would flicker.
 */

const NAV = [
  { href: '/services', label: 'Services' },
  { href: '/#how-it-works', label: 'How it works' },
  // There is no marketing page for professionals in Phase 1, and a nav link that
  // 404s is worse than one that lands on the sign-up form with the role toggle
  // already on screen.
  { href: '/login?tab=signup', label: 'For professionals' },
];

export function PublicHeader() {
  const { session, role, initialising } = useAuth();
  const pathname = usePathname();

  const home = session && role ? ROLE_HOME[role] ?? '/login' : null;

  return (
    <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600">
            <Wrench className="h-4 w-4 text-white" aria-hidden="true" />
          </span>
          <span className="text-lg font-semibold tracking-tight text-gray-900">SmartHelp</span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-5 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`text-sm font-medium hover:text-blue-700 ${
                pathname === item.href ? 'text-blue-700' : 'text-gray-700'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {initialising ? null : home ? (
            <Link
              href={home}
              className="rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              {role === 'professional' ? 'Your dashboard' : 'Your account'}
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:text-blue-700"
              >
                Log in
              </Link>
              <Link
                href="/services"
                className="rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                Get help
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="bg-[#0B1B3A] text-gray-300">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="flex items-center gap-2 text-white">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-600">
              <Wrench className="h-3.5 w-3.5 text-white" aria-hidden="true" />
            </span>
            <span className="text-base font-semibold">SmartHelp</span>
          </p>
          <p className="mt-3 text-sm text-gray-400">
            Verified home service professionals, transparent prices, and a slot you chose.
          </p>
        </div>

        <FooterColumn
          title="Services"
          links={[
            { href: '/services', label: 'Browse all services' },
            { href: '/services?category=cleaning', label: 'Cleaning' },
            { href: '/services?category=bathroom', label: 'Bathroom' },
            { href: '/services?category=appliance', label: 'Appliance repair' },
          ]}
        />
        <FooterColumn
          title="Company"
          links={[
            { href: '/#how-it-works', label: 'How it works' },
            { href: '/login?tab=signup', label: 'Become a professional' },
            { href: '/login', label: 'Log in' },
          ]}
        />
        <FooterColumn
          title="Support"
          links={[
            { href: '/services', label: 'Check coverage' },
            { href: '/login', label: 'Your bookings' },
          ]}
        />
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto max-w-7xl px-4 py-4 text-xs text-gray-500">
          © {new Date().getFullYear()} SmartHelp. Prices shown are estimates; the final price is
          confirmed before payment.
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { href: string; label: string }[];
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <li key={link.label}>
            <Link href={link.href} className="text-sm text-gray-400 hover:text-white">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
