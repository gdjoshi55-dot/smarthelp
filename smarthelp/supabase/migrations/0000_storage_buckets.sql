-- ============================================================
-- 0000_storage_buckets.sql
-- SmartHelp: the six Storage buckets, created before anything
-- else so Phase 0 can verify them in the Supabase dashboard.
--
-- Numbering note: the specification fixes the migration series
-- 0001-0028. This file sorts first because the bucket rows are
-- entirely self-contained and Phase 0 requires the buckets to
-- exist. It renumbers nothing.
--
-- The bucket *policies* are not here. They call public.is_admin()
-- (defined in 0001) and public.current_professional_id() (defined
-- in 0005), so a policy created before those would not resolve —
-- `create policy` does not defer its check to call time. They live
-- in 0025_storage_policies.sql, which sorts after both.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.15, §27
-- ============================================================

-- ── Buckets ─────────────────────────────────────────────────
-- Public buckets: catalogue art and professional photos are served
-- straight from a CDN URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('service-media',  'service-media',  true,  5242880,
   array['image/jpeg','image/png','image/webp','image/avif','image/svg+xml']),
  ('pro-photos',     'pro-photos',     true,  5242880,
   array['image/jpeg','image/png','image/webp']),
  ('kyc-documents',  'kyc-documents',  false, 5242880,
   array['image/jpeg','image/png','image/webp','application/pdf']),
  ('chat-media',     'chat-media',     false, 2097152,
   array['image/jpeg','image/png','image/webp']),
  ('support-media',  'support-media',  false, 2097152,
   array['image/jpeg','image/png','image/webp','application/pdf']),
  ('invoices',       'invoices',       false, 10485760,
   array['application/pdf'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── chat-media, support-media, invoices: private, no client
--    policies at all. Service role only until the phase that owns
--    them writes participant-scoped policies:
--      chat-media     -> 0019 / 0020_chat_notifications.sql
--      support-media  -> 0019_support.sql
--      invoices       -> 0012 / 0021 (Phase 3 payments)
--    A bucket with no policy is unreadable through the client API,
--    which is the correct default for every one of these.
