-- ============================================================
-- 0026_otp_signup_and_reset_purposes.sql
-- Widens public.otp_requests.purpose for the email + password
-- sign-up flow.
--
-- 0001 constrained purpose to ('login','staff_login','admin_mfa'),
-- which was correct while the only email codes were staff MFA.
-- The passwordless phone login has been replaced by SmartPOS-style
-- email + password sign-up, which needs two codes of its own:
--
--   'signup'         proves the person controls the mailbox before
--                    the auth user is created at all
--   'password_reset' proves the same before a password is changed
--
-- Both are keyed on the same (target, purpose) throttle, attempt
-- counter and lockout that already exist, so each gets an
-- independent budget and cannot be used to exhaust the others.
--
-- The channel stays 'email' for both. The 'phone' channel remains
-- supported by issue_otp/consume_otp for phone verification later
-- on, but the sign-up and reset paths only ever use email.
--
-- Idempotent: drops the old check by name if present, then adds one
-- with the full set. Safe to re-run.
-- Spec: §26.1
-- ============================================================

do $$ begin
  alter table public.otp_requests
    drop constraint if exists otp_requests_purpose_check;
exception
  when undefined_table then null;
end $$;

do $$ begin
  alter table public.otp_requests
    add constraint otp_requests_purpose_check
    check (purpose in (
      'login',
      'staff_login',
      'admin_mfa',
      'signup',
      'password_reset'
    ));
exception
  when duplicate_object then null;
end $$;

-- The audit action allow-list also enumerates purposes indirectly, so
-- make sure an existing account cannot be re-pointed at a purpose the
-- server does not recognise. The check constraint above is the single
-- source of truth; this index is the lookup the routes use to find an
-- open reset code for a target.
create index if not exists idx_otp_open_reset
  on public.otp_requests (target, purpose)
  where consumed_at is null and purpose = 'password_reset';
