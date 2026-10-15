-- ============================================================
-- 0043_surge_max_factor.sql
-- SmartHelp Phase 8: the platform-wide surge ceiling.
--
-- Spec: §7.4 (surge pricing), §24.14 (platform_settings), §31.1 (Phase 8).
-- Depends on: 0033 (platform_settings), 0035 (pricing_rules).
--
-- WHY THIS EXISTS
-- ---------------
-- §7.4 lets the engine raise a price inside a surge window. A
-- `pricing_rules` row carries the factor, but nothing bounds it but
-- the absolute `[0.50, 2.00]` clamp in `lib/pricing.ts` — so a
-- mistyped rule could double a customer's bill on its way in. This
-- key is the business-facing tunable that tightens that clamp: the
-- default 1.50 lets a rule raise a price by at most half, and an
-- admin can move it up to (but never past) 2.00.
--
-- It is a `platform_settings` row for the same reason every other
-- business knob is: it is a number a business retunes without a
-- deploy. `lib/settingsServer.ts` types it (`surgeMaxFactor`) and
-- falls back to `PLATFORM_DEFAULTS` if the row is absent, so this
-- seed is the live value and the constant is only the initial state.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

insert into public.platform_settings (key, value)
values ('surgeMaxFactor', '1.5'::jsonb)
on conflict (key) do nothing;
