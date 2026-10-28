-- ============================================================
-- 0045_professional_address.sql
-- SmartHelp: add a service address to professionals (A-like extension).
--
-- Professionals can store a fixed service address with coordinates so
-- admins/support can see it and it can be used for reference/matching.
-- Idempotent: safe to re-run on a live project.
-- ============================================================

alter table public.professionals
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists address_area text,
  add column if not exists address_city text,
  add column if not exists address_state text,
  add column if not exists address_pincode text,
  add column if not exists address_lat numeric(9,6),
  add column if not exists address_lng numeric(9,6),
  add column if not exists address_updated_at timestamptz;

comment on column public.professionals.address_line1 is 'Service address line 1';
comment on column public.professionals.address_line2 is 'Service address line 2';
comment on column public.professionals.address_area is 'Area/locality';
comment on column public.professionals.address_city is 'City';
comment on column public.professionals.address_state is 'State';
comment on column public.professionals.address_pincode is 'Pincode';
comment on column public.professionals.address_lat is 'Service address latitude';
comment on column public.professionals.address_lng is 'Service address longitude';
comment on column public.professionals.address_updated_at is 'When the service address was last updated';
