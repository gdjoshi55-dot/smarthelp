import { createClient, type Session, type User } from '@supabase/supabase-js';
import { ApiHttpError } from './api';
import { createServerClient } from './supabaseServer';
import { audit, clientIp } from './audit';
import { isOwnerLogin } from './owner';
import { CAPABILITIES, ROLE_LABELS, isStaffRole } from './roles';
import type { Profile, UserRole } from './supabase';

/**
 * Turning a correct password into a SmartHelp session.
 *
 * The password itself is the only thing Supabase Auth ever sees. Everything
 * after that — which role this account is, whether it is suspended, whether it
 * is the owner — is decided here, from the database, and written to the audit
 * ledger. The client never gets to assert any of it.
 *
 * Two callers share `grantSessionForUser`: `/api/auth/sign-in` for a returning
 * user, and `/api/auth/sign-up/complete` for one that was just created.
 */

export interface SessionGrant {
  session: Pick<Session, 'access_token' | 'refresh_token' | 'expires_at'>;
  profile: Profile;
  role: UserRole;
  roleLabel: string;
  capabilities: readonly string[];
}

/** A short-lived anon client, used only to ask Supabase to check a password. */
function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new ApiHttpError('INTERNAL_ERROR', 'Authentication is not configured.', 500);
  }
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Everything that happens between "the password was right" and "here is your
 * session": load the profile, apply the role and status gates, apply the owner
 * bootstrap, and record the login.
 *
 * `allow: 'staff'` narrows the gate to the four operations roles. The email +
 * password sign-in uses `'any'`, because a customer and an admin now use the
 * same form and the role decides the landing page rather than the endpoint.
 */
export async function grantSessionForUser(params: {
  user: User;
  session: Session;
  requestId: string;
  req: Request;
  allow?: 'any' | 'staff';
}): Promise<SessionGrant> {
  const { user, session, requestId, req, allow = 'any' } = params;
  const supabase = createServerClient();

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile) {
    throw new ApiHttpError(
      'UNAUTHENTICATED',
      'No profile exists for this login. Contact an administrator.',
      401
    );
  }
  if (allow === 'staff' && !isStaffRole(profile.role)) {
    throw new ApiHttpError('FORBIDDEN', 'This sign-in is for the operations team.', 403);
  }
  if (profile.status !== 'active') {
    throw new ApiHttpError(
      'FORBIDDEN',
      profile.status === 'suspended'
        ? 'This account is suspended. Contact an administrator.'
        : 'This account is not active.',
      403
    );
  }

  // The super_admin bootstrap. The one way an account becomes super_admin is
  // signing in with the login named in SMARTHELP_OWNER_LOGIN (server-only —
  // see lib/owner.ts). It can be removed afterwards, never granted to anyone.
  let role = profile.role;
  if (isOwnerLogin(profile.email) && role !== 'super_admin') {
    const promoted = await supabase
      .from('profiles')
      .update({ role: 'super_admin' })
      .eq('id', profile.id)
      .eq('role', profile.role)
      .select('role')
      .maybeSingle();
    if (!promoted.error && promoted.data?.role === 'super_admin') {
      await audit(supabase, {
        actorProfileId: profile.id,
        action: 'auth.owner_bootstrap',
        entityType: 'profiles',
        entityId: profile.id,
        before: { role: profile.role },
        after: { role: 'super_admin' },
        ipAddress: clientIp(req),
        userAgent: req.headers.get('user-agent'),
        requestId,
      });
      role = 'super_admin';
    }
  }

  await audit(supabase, {
    actorProfileId: profile.id,
    action: 'auth.login',
    entityType: 'profiles',
    entityId: profile.id,
    metadata: { method: 'password', role },
    ipAddress: clientIp(req),
    userAgent: req.headers.get('user-agent'),
    requestId,
  });

  return {
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
    },
    profile: { ...profile, role },
    role,
    roleLabel: ROLE_LABELS[role],
    capabilities: CAPABILITIES[role],
  };
}

/**
 * Check a password, then grant. Used by sign-in, and by sign-up/complete after
 * `admin.createUser` (which mints no session, so a real sign-in has to follow
 * it).
 *
 * The one message for "no such account", "wrong password" and "this address
 * has no password set" alike: distinguishing them turns sign-in into a way to
 * discover which addresses are registered.
 */
export async function signInWithPasswordAndGrant(params: {
  email: string;
  password: string;
  requestId: string;
  req: Request;
  allow?: 'any' | 'staff';
}): Promise<SessionGrant> {
  const { email, password, requestId, req, allow } = params;
  const { data, error } = await anonClient().auth.signInWithPassword({ email, password });
  if (error || !data?.user || !data.session) {
    throw new ApiHttpError(
      'UNAUTHENTICATED',
      'That email and password do not match an account.',
      401
    );
  }
  return grantSessionForUser({ user: data.user, session: data.session, requestId, req, allow });
}

/**
 * The gate the reset flow uses before it will write a new password: the
 * address must belong to a live account. The messages match the sign-in path
 * exactly, so the two are indistinguishable to someone probing for addresses.
 */
export async function requireActiveProfile(email: string): Promise<Profile> {
  const supabase = createServerClient();
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (!profile) {
    throw new ApiHttpError(
      'UNAUTHENTICATED',
      'That email and password do not match an account.',
      401
    );
  }
  if (profile.status !== 'active') {
    throw new ApiHttpError(
      'FORBIDDEN',
      profile.status === 'suspended'
        ? 'This account is suspended. Contact an administrator.'
        : 'This account is not active.',
      403
    );
  }
  return profile;
}
