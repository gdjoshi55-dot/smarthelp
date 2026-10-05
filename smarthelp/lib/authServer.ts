import { createServerClient } from './supabaseServer';
import { ApiHttpError } from './api';
import type { UserRole } from './supabase';

/**
 * Phone-first accounts and Supabase Auth.
 *
 * SmartHelp owns its own OTP ledger (`otp_requests`: salted SHA-256, TTL,
 * attempts, lockout, resend throttle) because a service check-in code and a
 * login code have different rules. The only documented Supabase API that can
 * mint a session from a server-side decision is `generateLink`, and it is
 * keyed on email. So a phone-only account is created with a synthetic,
 * undeliverable address on the RFC 2606 `.invalid` TLD:
 *
 *     +919000000001@auth.smarthelp.invalid
 *
 * It is never delivered, never displayed, and `profiles.email` stays NULL —
 * the phone remains the identifier a human uses. It exists only so the
 * one-time `token_hash` handshake has a key to attach to. See docs/ARCHITECTURE.md.
 */

const PHONE_EMAIL_SUFFIX = '@auth.smarthelp.invalid';

/**
 * Maps a phone to the synthetic address the `generateLink` handshake needs.
 *
 * Digits only. If the `+` were kept, `+919876543210@…` and
 * `919876543210@…` would be two different addresses for one person — and this
 * address is the auth identity, so the failure mode is two accounts, not a
 * rejected sign-in. Callers are expected to have run the value through
 * `normalizePhone` already; the strip here is the second line of defence.
 */
export function syntheticEmailFor(phoneE164: string): string {
  return `${phoneE164.replace(/\D/g, '')}${PHONE_EMAIL_SUFFIX}`.toLowerCase();
}

export function isSyntheticEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(PHONE_EMAIL_SUFFIX);
}

/**
 * Shows enough of an address to be recognisable and not enough to be useful
 * to someone reading over a shoulder or scraping a response. Shared by every
 * endpoint that reports which address a code went to.
 */
export function maskEmail(value: string): string {
  const [local, domain] = value.split('@');
  if (!domain) return value;
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/**
 * Creates the auth user for a phone number if it does not exist yet.
 * `handle_new_user()` (0001) provisions the profile and, for a customer, the
 * customers row. Staff roles are never accepted here.
 */
export async function ensureAuthUserForPhone(params: {
  phone: string;
  fullName: string;
  role: Extract<UserRole, 'customer' | 'professional'>;
}): Promise<{ userId: string; email: string }> {
  const { phone, fullName, role } = params;
  const supabase = createServerClient();
  const email = syntheticEmailFor(phone);

  // The phone is the identity, and uniq_profiles_phone makes this an index
  // lookup rather than a scan.
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('id, role, full_name')
    .eq('phone', phone)
    .maybeSingle();

  let userId = existingProfile?.id ?? null;

  if (!userId) {
    const created = await supabase.auth.admin.createUser({
      email,
      phone,
      email_confirm: true,
      user_metadata: { full_name: fullName, role, phone },
    });
    if (created.error || !created.data?.user) {
      const e = new Error(
        created.error?.message || 'Could not start a session for this number'
      ) as Error & { code?: string };
      e.code = 'AUTH_USER_CREATE_FAILED';
      throw e;
    }
    userId = created.data.user.id;
  }

  // Keep the profile in step with the requested name, without ever letting a
  // self-sign-up set a staff role. A customer who later applies to be a
  // professional is promoted; the reverse is not offered.
  if (existingProfile && existingProfile.role === 'customer' && role === 'professional') {
    await supabase
      .from('profiles')
      .update({ role: 'professional' })
      .eq('id', userId)
      .eq('role', 'customer');
    await supabase.from('customers').delete().eq('profile_id', userId);
  } else if (
    existingProfile &&
    existingProfile.full_name !== fullName &&
    existingProfile.role === role
  ) {
    await supabase
      .from('profiles')
      .update({ full_name: fullName })
      .eq('id', userId)
      .eq('role', role);
  }

  return { userId, email };
}

/**
 * Turns a verified login into a one-time `token_hash` the client exchanges for
 * a session with `supabase.auth.verifyOtp({ token_hash, type: 'email' })`.
 * Nothing is created and no session is minted on this side of the handshake.
 */
export async function issueSessionHandshake(
  email: string,
  redirectTo: string
): Promise<{ tokenHash: string }> {
  const supabase = createServerClient();
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo },
  });

  const props = (data as any)?.properties;
  const tokenHash = props?.hashed_token ?? (data as any)?.hashed_token;

  if (error || !tokenHash) {
    console.error('generateLink failed:', error?.message ?? 'no hashed_token');
    throw new ApiHttpError(
      'INTERNAL_ERROR',
      'We could not complete the sign-in. Please request a new code.',
      500
    );
  }

  return { tokenHash };
}
