-- ============================================================
-- 0046_hooghly_locations.sql
-- SmartHelp: add Hooghly (West Bengal) and its Mogra / Amodghata
-- locality, and make every active service bookable there.
--
-- A customer at the Mogra pin (22.987850, 88.387620, pincode
-- 712503) had no locality row to resolve to, so address save
-- rejected the exact pin. The locality name carries both places
-- people type so a name, a pincode or the point all resolve.
--
-- Idempotent: safe to re-run on a live project.
-- ============================================================

-- City
insert into public.cities (name, state, lat, lng)
values ('Hooghly', 'West Bengal', 22.987850, 88.387620)
on conflict (lower(name), lower(state)) do nothing;

-- Localities
-- (name, lat, lng, radius_km, pincodes)
insert into public.localities (city_id, name, lat, lng, radius_km, pincodes)
select c.id, v.name, v.lat, v.lng, v.radius_km, v.pincodes::text[]
from (values
  ('Mogra - Amodghata', 22.987850, 88.387620, 12.00, '{712503}')
) as v(name, lat, lng, radius_km, pincodes)
join public.cities c
  on lower(c.name) = 'hooghly' and lower(c.state) = 'west bengal'
on conflict (city_id, lower(name)) do nothing;

-- Service areas (coverage)
-- A service is bookable only where an active service_areas row
-- exists, so every active service gets one in the locality.
insert into public.service_areas (locality_id, service_id, lead_minutes, slot_capacity)
select l.id, s.id,
       greatest(s.prep_minutes, 0),
       4
from public.localities l
join public.cities c on c.id = l.city_id
join public.services s on true
where lower(c.name) = 'hooghly'
  and lower(c.state) = 'west bengal'
  and s.is_active
on conflict (locality_id, service_id) do update
  set lead_minutes  = excluded.lead_minutes,
      slot_capacity = excluded.slot_capacity,
      is_active     = true;
