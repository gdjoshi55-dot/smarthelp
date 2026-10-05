import type { UserRole } from './supabase';

/**
 * Roles and capabilities (§3.1, §3.2, §19.3).
 *
 * There is no role hierarchy: every capability is an explicit grant. The same
 * table is used by the client (to decide what to render) and by the Route
 * Handlers (to decide what to allow), so the two can never disagree.
 */

export const USER_ROLES: UserRole[] = [
  'customer',
  'professional',
  'admin',
  'support',
  'ops',
  'super_admin',
];

export const ROLE_LABELS: Record<UserRole, string> = {
  customer: 'Customer',
  professional: 'Professional',
  admin: 'Admin',
  support: 'Support',
  ops: 'Operations',
  super_admin: 'Owner',
};

/**
 * Every capability the product defines, in one list.
 *
 * The type is derived from the data so a new capability cannot be added to the
 * type and forgotten in the list. `super_admin` holds `'*'`, and
 * `capabilitiesFor()` expands that into this list — the client is handed the
 * expanded set, never the wildcard, because a client that tested
 * `capabilities.includes('role.manage')` would read `'*'` as a denial and lock
 * the owner out of the very screen only the owner can reach.
 */
export const ALL_CAPABILITIES = [
  'booking.create',
  'booking.cancel.own',
  'booking.read.all',
  'booking.assign',
  'booking.cancel.any',
  'offer.accept',
  'service.start',
  'service.complete',
  'availability.write',
  'kyc.submit',
  'kyc.review',
  'pro.verify',
  'pro.suspend',
  'service.manage',
  'pricing.manage',
  'refund.request',
  'refund.execute',
  'coupon.manage',
  'dispute.resolve',
  'ticket.read.all',
  'ticket.write',
  'analytics.all',
  'audit.read',
  'role.manage',
] as const;

export type Capability = (typeof ALL_CAPABILITIES)[number];

/** '*' means every capability. Only super_admin carries it. */
export const CAPABILITIES: Record<UserRole, readonly Capability[] | readonly ['*']> = {
  customer: ['booking.create', 'booking.cancel.own'],
  professional: ['offer.accept', 'service.start', 'service.complete', 'availability.write', 'kyc.submit'],
  support: ['ticket.read.all', 'ticket.write', 'refund.request'],
  ops: [
    'booking.read.all',
    'booking.assign',
    'booking.cancel.any',
    'refund.execute',
    'dispute.resolve',
    'ticket.read.all',
    'ticket.write',
  ],
  admin: [
    'booking.create',
    'booking.cancel.own',
    'booking.read.all',
    'booking.assign',
    'booking.cancel.any',
    'service.manage',
    'pricing.manage',
    'coupon.manage',
    'kyc.review',
    'pro.verify',
    'pro.suspend',
    'refund.request',
    'refund.execute',
    'dispute.resolve',
    'ticket.read.all',
    'ticket.write',
    'analytics.all',
    'audit.read',
    'role.manage',
  ],
  super_admin: ['*'],
};

/**
 * The capabilities a role actually holds, wildcard expanded.
 *
 * This is what both the client and the Route Handlers should ask. A new role
 * cannot be added here by accident: the value comes from the table above.
 */
export function capabilitiesFor(role: UserRole | null | undefined): Capability[] {
  if (!role) return [];
  const granted = CAPABILITIES[role] as readonly string[] | undefined;
  if (!Array.isArray(granted)) return [];
  if (granted.includes('*')) return [...ALL_CAPABILITIES];
  return granted as Capability[];
}

/**
 * Fails closed.
 *
 * The role is read from the database, not from the client, so an unrecognised
 * value here means a row that no longer matches the enum. The right answer to
 * that is "no permissions", and it has to be `false` rather than a thrown
 * TypeError: a crash inside a capability check turns a deny into a 500, and a
 * 500 is not a deny.
 */
export function can(role: UserRole | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return capabilitiesFor(role).includes(capability);
}

export function isStaffRole(role: UserRole | null | undefined): boolean {
  return role === 'admin' || role === 'ops' || role === 'support' || role === 'super_admin';
}

export function isAdminRole(role: UserRole | null | undefined): boolean {
  return role === 'admin' || role === 'super_admin';
}

/** Where each role lands after signing in, and what its shell expects. */
export const ROLE_HOME: Record<UserRole, string> = {
  customer: '/customer',
  professional: '/professional',
  admin: '/admin',
  ops: '/admin',
  support: '/admin',
  super_admin: '/admin',
};

/** The shell a role belongs to. Used to redirect a user who hits the wrong one. */
export function shellForRole(role: UserRole): 'customer' | 'professional' | 'admin' {
  if (role === 'customer') return 'customer';
  if (role === 'professional') return 'professional';
  return 'admin';
}

export const ROLE_SECTIONS: Record<UserRole, string[]> = {
  customer: ['home', 'bookings', 'wallet', 'support', 'favourites', 'profile'],
  professional: ['home', 'jobs', 'earnings', 'kyc', 'availability', 'training', 'profile'],
  support: ['dashboard', 'bookings', 'disputes', 'support', 'customers', 'audit'],
  ops: [
    'dashboard',
    'bookings',
    'professionals',
    'payments',
    'disputes',
    'support',
    'analytics',
    'audit',
  ],
  admin: [
    'dashboard',
    'bookings',
    'professionals',
    'customers',
    'services',
    'pricing',
    'payments',
    'coupons',
    'disputes',
    'support',
    'analytics',
    'notifications',
    'settings',
    'audit',
  ],
  super_admin: [
    'dashboard',
    'bookings',
    'professionals',
    'customers',
    'services',
    'pricing',
    'payments',
    'coupons',
    'disputes',
    'support',
    'analytics',
    'notifications',
    'settings',
    'audit',
  ],
};
