-- ============================================================
-- 0025_storage_policies.sql
-- The object policies for the six buckets created in
-- 0000_storage_buckets.sql.
--
-- These were originally in 0000, which cannot work: a policy body
-- is checked when the policy is created, and they call
-- public.is_admin() (0001) and public.current_professional_id()
-- (0005). On a fresh project, applying in filename order therefore
-- failed at the very first file with
-- "function public.is_admin() does not exist".
--
-- 0025 sorts after both, so the functions exist when these are
-- created. Nothing here depends on anything later.
--
-- Idempotent: every policy is created inside a block that swallows
-- duplicate_object, so a re-run is a no-op rather than an error.
-- Spec: §24.15, §27
-- ============================================================

-- ── service-media: world-readable, admin-written ────────────
do $$ begin
  create policy service_media_public_read on storage.objects for select
    using (bucket_id = 'service-media');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_media_admin_write on storage.objects for insert
    with check (bucket_id = 'service-media' and public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_media_admin_update on storage.objects for update
    using (bucket_id = 'service-media' and public.is_admin())
    with check (bucket_id = 'service-media' and public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy service_media_admin_delete on storage.objects for delete
    using (bucket_id = 'service-media' and public.is_admin());
exception when duplicate_object then null; end $$;

-- ── pro-photos: public bucket, but a pro may only write its own folder.
--    Objects are named '<profileId>/<filename>' by the upload route.
do $$ begin
  create policy pro_photos_public_read on storage.objects for select
    using (bucket_id = 'pro-photos');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_photos_insert_own on storage.objects for insert
    with check (bucket_id = 'pro-photos'
                and (public.is_admin()
                     or (storage.foldername(name))[1] = auth.uid()::text));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_photos_update_own on storage.objects for update
    using (bucket_id = 'pro-photos'
           and (public.is_admin()
                or (storage.foldername(name))[1] = auth.uid()::text))
    with check (bucket_id = 'pro-photos'
                and (public.is_admin()
                     or (storage.foldername(name))[1] = auth.uid()::text));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy pro_photos_delete_own on storage.objects for delete
    using (bucket_id = 'pro-photos'
           and (public.is_admin()
                or (storage.foldername(name))[1] = auth.uid()::text));
exception when duplicate_object then null; end $$;

-- ── kyc-documents: private. There is deliberately NO select policy,
--    so a signed-in professional cannot read the object back with the
--    anon key. Metadata lives in professional_documents; the bytes are
--    fetched through a staff-guarded signed URL (Phase 4).
--    Objects are named '<professionalId>/<docType>/<file>'.
do $$ begin
  create policy kyc_insert_own on storage.objects for insert
    with check (bucket_id = 'kyc-documents'
                and (public.is_admin()
                     or (storage.foldername(name))[1] =
                         public.current_professional_id()::text));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy kyc_update_own on storage.objects for update
    using (bucket_id = 'kyc-documents'
           and (public.is_admin()
                or (storage.foldername(name))[1] =
                    public.current_professional_id()::text))
    with check (bucket_id = 'kyc-documents'
                and (public.is_admin()
                     or (storage.foldername(name))[1] =
                         public.current_professional_id()::text));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy kyc_admin_delete on storage.objects for delete
    using (bucket_id = 'kyc-documents' and public.is_admin());
exception when duplicate_object then null; end $$;
