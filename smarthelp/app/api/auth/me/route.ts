import { NextResponse } from 'next/server';
import { ApiHttpError, handle, ok } from '@/lib/api';
import { readJson, requireAuth, validateUpdateMe } from '@/lib/validation';
import { createServerClient } from '@/lib/supabaseServer';
import { audit, clientIp } from '@/lib/audit';
import { CAPABILITIES, ROLE_LABELS, ROLE_SECTIONS, ROLE_HOME, capabilitiesFor } from '@/lib/roles';
import type { TablesUpdate, UserRole } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/me
 *
 * The profile, the role, the capabilities and the navigation for that role.
 * This is the single call the client makes after any sign-in, and the answer
 * always comes from the database — the role a user sees is the role the row
 * holds, never one the browser asserted.
 */
export async function GET(req: Request) {
  return handle(req, 'auth.me', async () => {
    const auth = await requireAuth(req);
    const supabase = createServerClient();

    const [customerRes, professionalRes] = await Promise.all([
      supabase
        .from('customers')
        .select('id, referral_code, total_bookings, completed_bookings, lifetime_value')
        .eq('profile_id', auth.userId)
        .maybeSingle(),
      supabase
        .from('professionals')
        .select('id, verification_status, training_status, availability_status, is_available_today, rating, rating_count')
        .eq('profile_id', auth.userId)
        .maybeSingle(),
    ]);

    await supabase
      .from('profiles')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', auth.userId);

    const { id, ...profile } = auth.profile;
    const role = auth.role as UserRole;

    return ok({
      profile,
      role,
      roleLabel: ROLE_LABELS[role],
      // Expanded, never the '*' wildcard: a client that tested this array with
      // `includes` would read '*' as a denial.
      capabilities: capabilitiesFor(role),
      sections: ROLE_SECTIONS[role],
      home: ROLE_HOME[role],
      customer: customerRes.data ?? null,
      professional: professionalRes.data ?? null,
      serverNow: new Date().toISOString(),
    });
  });
}

/**
 * PUT /api/auth/me
 *
 * Name, email, avatar, locale. Role and status are not in this payload and are
 * not reachable from it: the column grant on `profiles` excludes them, and the
 * `guard_profile_privileges()` trigger rejects the change even if the grant is
 * ever widened.
 */
export async function PUT(req: Request) {
  return handle(req, 'auth.me.update', async (requestId) => {
    const auth = await requireAuth(req);
    const body = await readJson(req);

    // The shared validator, not a second copy of it: `role` and `status` are
    // simply not in the allow-list, so there is nothing to filter out here.
    const patch = validateUpdateMe(body) as TablesUpdate<'profiles'>;

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from('profiles')
      .update(patch)
      .eq('id', auth.userId)
      .select('*')
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        throw new ApiHttpError(
          'VALIDATION_ERROR',
          'Another account already uses that email address.',
          409,
          { fields: { email: 'Already in use' } }
        );
      }
      throw error;
    }

    const before: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      before[key] = (auth.profile as Record<string, unknown>)[key];
    }

    await audit(supabase, {
      actorProfileId: auth.userId,
      action: 'profile.update',
      entityType: 'profiles',
      entityId: auth.userId,
      before,
      after: patch as Record<string, unknown>,
      ipAddress: clientIp(req),
      userAgent: req.headers.get('user-agent'),
      requestId,
    });

    return ok({ profile: data });
  });
}
