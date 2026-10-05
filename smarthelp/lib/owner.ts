/**
 * The super_admin bootstrap allow-list (§26.1), mirroring the SmartPOS owner
 * pattern in lib/owner.ts.
 *
 * A user cannot grant themselves a role: the sign-up handler refuses staff
 * roles outright, and the `guard_profile_privileges()` trigger blocks a role
 * change from a browser request. The one exception is this allow-list — the
 * single login named in the owner variable is promoted to super_admin on first
 * sign-in.
 *
 * Key naming follows SmartPOS, which sets both halves of its equivalent pair:
 *   ALTASOFTWARE_OWNER_LOGIN            (server)
 *   NEXT_PUBLIC_ALTASOFTWARE_OWNER_LOGIN (browser)
 * so the same shape is used here, but only the server half is read below.
 *
 * Note for whoever builds the admin role-management screen: the trigger lets an
 * *admin* change any role, including to super_admin, because it tells admin
 * apart from everyone else rather than owner apart from admin. Nothing exposes
 * that today. That screen must refuse super_admin explicitly, and the check
 * belongs on the server — hiding it in the UI is not a control.
 */
// Deliberately the server-only variable, with no NEXT_PUBLIC_ fallback.
//
// Two reasons, and the second one is the real one:
//
//  1. Bundlers statically replace a `process.env.NEXT_PUBLIC_*` member access
//     with the value they loaded from the env files at build time. Reading one
//     here therefore does not see the live process environment at all, which
//     made the allow-list silently compare against a value baked into the
//     bundle. It is also why reading through an alias does not help: the
//     substitution is not limited to the literal `process.env.X` spelling.
//
//  2. This decides who becomes super_admin. A NEXT_PUBLIC_ value is compiled
//     into the client bundle and readable by anyone who loads the page, so it
//     must not be an input to a privilege decision. The pair still exists in
//     .env for the owner-only UI, as it does in SmartPOS, but the UI is not a
//     control and is never consulted for this.
export const OWNER_LOGIN = (process.env.SMARTHELP_OWNER_LOGIN || '')
  .toLowerCase()
  .trim();

export function isOwnerLogin(loginName?: string | null): boolean {
  if (!OWNER_LOGIN || !loginName) return false;
  const value = loginName.toLowerCase().trim();
  return value === OWNER_LOGIN || value === `${OWNER_LOGIN}@smarthelp.test`;
}
