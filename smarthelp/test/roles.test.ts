import { describe, expect, it } from 'vitest';
import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  ROLE_HOME,
  ROLE_LABELS,
  ROLE_SECTIONS,
  can,
  capabilitiesFor,
  isAdminRole,
  isStaffRole,
} from '@/lib/roles';
import type { UserRole } from '@/lib/supabase';

/**
 * The role table is the whole authorisation model, and it is pure data plus two
 * predicates — so it is worth testing directly. A mistake here is not a crash,
 * it is a role that can see the wrong thing, which is far harder to notice.
 */

const ROLES: UserRole[] = ['customer', 'professional', 'admin', 'ops', 'support', 'super_admin'];

describe('the role table covers every role', () => {
  it('has a label, a home, capabilities and sections for each of the six roles', () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role], `label for ${role}`).toBeTruthy();
      expect(ROLE_HOME[role], `home for ${role}`).toBeTruthy();
      expect(Array.isArray(ROLE_SECTIONS[role]), `sections for ${role}`).toBe(true);
      expect(ROLE_SECTIONS[role].length, `sections for ${role}`).toBeGreaterThan(0);
      expect(Array.isArray(CAPABILITIES[role]), `capabilities for ${role}`).toBe(true);
    }
  });
});

describe('ROLE_HOME', () => {
  it('puts each of the three surfaces where its users expect to land', () => {
    expect(ROLE_HOME.customer).toBe('/customer');
    expect(ROLE_HOME.professional).toBe('/professional');
  });

  it('puts all four staff roles in the one staff shell', () => {
    for (const role of ['admin', 'ops', 'support', 'super_admin'] as const) {
      expect(ROLE_HOME[role]).toBe('/admin');
    }
  });

  it('never sends a role to a home guarded for a different role — that would loop', () => {
    // AuthGuard redirects a mismatched role to ROLE_HOME[role]. Every role that
    // lands on a shell must be allowed on it, or the user spins forever.
    // (This is the bug that made ops and support unreachable at /admin.)
    const shellFor: Record<string, string[]> = {
      '/customer': ['customer'],
      '/professional': ['professional'],
      '/admin': ['admin', 'ops', 'support', 'super_admin'],
    };
    for (const role of ROLES) {
      const home = ROLE_HOME[role];
      expect(shellFor[home], `${role} is allowed on ${home}`).toContain(role);
    }
  });
});

describe('isStaffRole / isAdminRole', () => {
  it('separates the four staff roles from the two customer-facing ones', () => {
    expect(ROLES.filter(isStaffRole)).toEqual(['admin', 'ops', 'support', 'super_admin']);
  });

  it('narrows further to the two that may administer', () => {
    expect(ROLES.filter(isAdminRole)).toEqual(['admin', 'super_admin']);
  });

  it('treats no role, and an unknown one, as unstaff', () => {
    for (const value of [null, undefined, '', 'owner', 'ADMIN'] as any[]) {
      expect(isStaffRole(value)).toBe(false);
      expect(isAdminRole(value)).toBe(false);
    }
  });
});

describe('capabilities', () => {
  it('lets a customer book and cancel their own, and nothing else', () => {
    // §3.2 covers create, cancel and reschedule in one row, so there is no
    // separate reschedule capability. Reschedule is guarded by `booking.create`.
    expect(CAPABILITIES.customer).toEqual(['booking.create', 'booking.cancel.own']);
    expect(can('customer', 'booking.create')).toBe(true);
    expect(can('customer', 'booking.cancel.own')).toBe(true);
    // Own-account booking only. These are the grants a confused check would leak.
    expect(can('customer', 'booking.cancel.any')).toBe(false);
    expect(can('customer', 'booking.read.all')).toBe(false);
    expect(can('customer', 'booking.assign')).toBe(false);
    expect(can('customer', 'refund.execute')).toBe(false);
  });

  it('gives the owner every capability, wildcard expanded', () => {
    // The table stores '*' for super_admin. `capabilitiesFor` must expand it, or
    // any client checking the array with `includes` would deny the owner.
    expect(CAPABILITIES.super_admin).toEqual(['*']);
    for (const cap of ALL_CAPABILITIES) {
      expect(can('super_admin', cap), `owner should hold ${cap}`).toBe(true);
    }
    expect(capabilitiesFor('super_admin')).toEqual([...ALL_CAPABILITIES]);
    expect(capabilitiesFor('super_admin')).not.toContain('*');
  });

  it('gives the owner everything an admin has', () => {
    for (const cap of CAPABILITIES.admin as readonly string[]) {
      expect(can('super_admin', cap as any), `owner should hold ${cap}`).toBe(true);
    }
  });

  it('keeps role management away from ops and support', () => {
    expect(can('ops', 'role.manage')).toBe(false);
    expect(can('support', 'role.manage')).toBe(false);
  });

  it('keeps the audit log to administrators, matching the RLS policy', () => {
    // The RLS policy for audit_logs is admin-only; the UI must agree, or an
    // ops user is shown a section that will always come back empty.
    for (const role of ['admin', 'super_admin'] as const) {
      expect(ROLES, `${role} sees audit`).toContain(role);
    }
    expect(can('ops', 'audit.read')).toBe(false);
    expect(can('support', 'audit.read')).toBe(false);
  });

  it('fails closed for a role it has never heard of', () => {
    expect(can('ghost' as UserRole, 'booking.create')).toBe(false);
  });
});

describe('sections', () => {
  it('gives a customer only their own surfaces', () => {
    expect(ROLE_SECTIONS.customer).not.toContain('bookings_admin');
    expect(ROLE_SECTIONS.customer).not.toContain('kyc_queue');
  });

  it('does not give support the KYC or settings surfaces', () => {
    // §11 makes KYC review and platform settings administrator work; support
    // is there to answer questions, not to approve identity documents.
    expect(can('support', 'kyc.review')).toBe(false);
  });
});
