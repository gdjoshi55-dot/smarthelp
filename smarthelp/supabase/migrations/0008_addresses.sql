-- ============================================================
-- 0008_addresses.sql
-- SmartHelp: a customer's saved addresses, and the one
-- transaction that makes a default address.
--
-- Everything downstream of Phase 1 gates on a locality:
-- a service is bookable where an active service_areas row
-- exists, and that row is keyed on locality. An address is
-- how a locality gets resolved from something a person can
-- actually type or grant from the browser.
--
-- Idempotent: safe to re-run on a live project.
-- Spec: §24.6, §5.2, §5.4
-- ============================================================

do $$ begin
  create type address_type as enum ('home','work','other');
exception when duplicate_object then null; end $$;

create table if not exists public.addresses (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id) on delete cascade,
  locality_id  uuid references public.localities(id) on delete set null,
  label        text not null default 'Home',
  address_type address_type not null default 'home',
  line1        text not null,          -- flat / house
  line2        text,                   -- building / society
  area         text not null,          -- locality name, as typed
  city         text not null,
  state        text not null,
  pincode      text not null,
  lat          numeric(9,6) not null,
  lng          numeric(9,6) not null,
  landmark     text,
  -- Gate code, floor, "no lift on 4th", parking. Shown to the
  -- professional during the approach, and the field whose absence
  -- loses the most jobs on arrival.
  access_notes text,
  -- 'exact' when the browser gave us a pin, 'locality_centre' when the
  -- person typed an area and we fell back to the locality's middle. §5.4
  -- makes the professional's approach depend on which, and §9.1 warns the
  -- customer to add a landmark in the second case — so the difference has
  -- to outlive the write, not just the response that carried it.
  location_precision text not null default 'locality_centre',
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- Cheap here, expensive to debug later. A latitude of 191 or a
  -- four-digit pincode is always a bad geocode, never a real address.
  constraint latitude_in_range  check (lat between -90 and 90),
  constraint longitude_in_range check (lng between -180 and 180),
  constraint pincode_shape     check (pincode ~ '^[0-9]{6}$'),
  constraint line1_present     check (length(btrim(line1)) > 0),
  constraint area_present      check (length(btrim(area)) > 0),
  constraint precision_known   check (location_precision in ('exact','locality_centre'))
);

-- The precision column was added after 0008 had already been applied on some
-- projects, and `create table if not exists` will not add a column to a table
-- that exists. Without this, a re-run would leave the old table without the
-- column every insert now writes.
alter table public.addresses
  add column if not exists location_precision text not null default 'locality_centre';

do $$ begin
  alter table public.addresses
    add constraint precision_known
      check (location_precision in ('exact','locality_centre'));
exception when duplicate_object then null; end $$;

comment on column public.addresses.locality_id is
  'Resolved from `area` or `lat`/`lng` at save time, and re-used by every
   availability check. NULL happens only when a locality is deleted from under
   the row (`on delete set null`): an address that cannot be placed in the
   first place is refused by the API, because lat/lng are not null and a
   guessed point sends the professional to the wrong building. When the id is
   NULL the API answers with `coverage: ''not_yet_available''` and the UI shows
   a badge. The resolution rule lives in lib/geo.ts, not here, because it is
   business logic with radius semantics and wants unit tests.';

-- Exactly one default per customer. A partial unique index, because the
-- column is nullable and a plain unique would count the NULLs.
create unique index if not exists uniq_default_address
  on public.addresses (customer_id) where is_default;
create index if not exists idx_addresses_customer
  on public.addresses (customer_id, created_at desc);
create index if not exists idx_addresses_locality
  on public.addresses (locality_id) where locality_id is not null;

drop trigger if exists trg_addresses_touch on public.addresses;
create trigger trg_addresses_touch before update on public.addresses
  for each row execute function public.touch_updated_at();

-- ── Set the default, in one transaction ─────────────────────
-- Two statements from a Route Handler ("clear all, then set this")
-- can interleave with a second request and leave a customer with no
-- default address at all. The whole thing is one statement here,
-- so the invariant holds even under two simultaneous calls.
create or replace function public.set_default_address(
  p_customer_id uuid,
  p_address_id  uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  -- The function is callable directly, so it checks ownership itself
  -- rather than trusting whoever wired it up.
  if not (
       public.is_trusted_session()
       or auth.role() = 'service_role'
       or public.is_admin()
       or public.current_customer_id() = p_customer_id
     ) then
    raise exception 'ADDRESS_NOT_OWNED'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.addresses where id = p_address_id and customer_id = p_customer_id
  ) then
    raise exception 'ADDRESS_NOT_FOUND'
      using errcode = 'foreign_key_violation';
  end if;

  update public.addresses set is_default = false where customer_id = p_customer_id and is_default;
  update public.addresses set is_default = true  where id = p_address_id;

  return p_address_id;
end $$;

comment on function public.set_default_address(uuid, uuid) is
  'Clears the customer''s default and sets this one, atomically.';

-- ── RLS ─────────────────────────────────────────────────────
-- An address is the most sensitive row a customer owns: it is
-- where they live, and `access_notes` describes how to get in.
-- So there is no anon grant at all, and no policy an anonymous
-- session can satisfy — `current_customer_id()` is NULL without
-- an `auth.uid()`, and NULL = NULL is false in a `using` clause.
--
-- The Route Handlers use the service role and enforce ownership in
-- the handler, which is what allows staff support tooling to read
-- an address; a browser session cannot take that path.
alter table public.addresses enable row level security;

do $$ begin
  create policy addresses_select_own on public.addresses for select
    using (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy addresses_insert_own on public.addresses for insert
    with check (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy addresses_update_own on public.addresses for update
    using (customer_id = public.current_customer_id())
    with check (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy addresses_delete_own on public.addresses for delete
    using (customer_id = public.current_customer_id());
exception when duplicate_object then null; end $$;

revoke all on public.addresses from anon;
grant select, insert, update, delete on public.addresses to authenticated;
grant execute on function public.set_default_address(uuid, uuid) to authenticated, service_role;

-- ── Deferred to Phase 2 ─────────────────────────────────────
-- §24.6 also defines block_address_delete_with_future_bookings(),
-- which refuses to delete an address a live booking points at. It is
-- not here because it references `bookings`, and a migration that
-- names a table that does not exist fails to apply. Nothing can
-- reference an address yet, so there is nothing to guard; the
-- function ships with the booking tables.
--
-- Likewise, addresses.area is compared to localities.name in §5.3
-- rather than joined on a stored locality_id. The stored id is the
-- better key — it survives a locality being renamed — so it is what
-- Phase 1 uses, and locality_id is nullable only so that deleting a
-- locality cannot fail on the rows that pointed at it.
