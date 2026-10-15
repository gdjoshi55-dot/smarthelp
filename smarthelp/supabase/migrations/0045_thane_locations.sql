-- ============================================================
-- 0045_thane_locations.sql
-- SmartHelp: add Thane (Maharashtra) as a second city, its two
-- launch localities — Thane West – Hill Garden (Hill Garden,
-- Happy Valley, Cosmos, Kalptaru · pin 400610) and Edan Wood –
-- Garden Estate — and make every active service bookable in both.
--
-- Adds `localities.pincodes` so a typed pincode resolves to a
-- locality the same way a typed area does (the hero search has
-- always routed a six-digit query to `area`, and it matched
-- nothing until there was a column to match it against).
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

-- ── Locality pincodes ───────────────────────────────────────
-- Reference data stays a row, never code: a locality carries the
-- pins people actually type for it.
alter table public.localities
  add column if not exists pincodes text[] not null default '{}';

comment on column public.localities.pincodes is
  'Pincodes served by this locality. Matched exactly by lib/geo.ts when a person types a pincode.';

-- ── City ────────────────────────────────────────────────────
insert into public.cities (name, state, lat, lng)
values ('Thane', 'Maharashtra', 19.218300, 72.978100)
on conflict (lower(name), lower(state)) do nothing;

-- ── Localities ──────────────────────────────────────────────
-- The first locality carries every society in the cluster so a customer who
-- types the name of theirs ("Hill Garden", "Happy Valley", "Cosmos",
-- "Kalptaru") resolves by name as well as by pincode or by point.
-- (name, lat, lng, radius_km, pincodes)
insert into public.localities (city_id, name, lat, lng, radius_km, pincodes)
select c.id, v.name, v.lat, v.lng, v.radius_km, v.pincodes::text[]
from (values
  ('Thane West – Hill Garden, Happy Valley, Cosmos, Kalptaru',
   19.238000, 72.972000, 6.00, '{400610}'),
  ('Edan Wood – Garden Estate', 19.225000, 72.965000, 5.00, '{}')
) as v(name, lat, lng, radius_km, pincodes)
join public.cities c
  on lower(c.name) = 'thane' and lower(c.state) = 'maharashtra'
on conflict (city_id, lower(name)) do nothing;

-- ── Service areas (coverage) ────────────────────────────────
-- A service is bookable only where an active service_areas row
-- exists, so every active service gets one in both localities.
insert into public.service_areas (locality_id, service_id, lead_minutes, slot_capacity)
select l.id, s.id,
       greatest(s.prep_minutes, 0),
       4
from public.localities l
join public.cities c on c.id = l.city_id
join public.services s on true
where lower(c.name) = 'thane'
  and lower(c.state) = 'maharashtra'
  and s.is_active
on conflict (locality_id, service_id) do update
  set lead_minutes  = excluded.lead_minutes,
      slot_capacity = excluded.slot_capacity,
      is_active     = true;
