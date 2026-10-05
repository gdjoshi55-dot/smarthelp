-- ============================================================
-- 0007_service_catalogue_seed.sql
-- SmartHelp: the launch city, its localities, the five service
-- categories, twenty services, their duration ladder, their
-- scope contract, and where each service is offered.
--
-- Everything here is a row an admin can edit. Nothing in the app
-- hardcodes a category, a service, a price or a coverage area.
--
-- Idempotent: safe to re-run. Inserts are keyed on the natural
-- unique key (slug / name / service+minutes / locality+service),
-- so a re-run updates nothing and inserts nothing.
--
-- Spec: §4.1, §4.3, §4.4, §5.1
-- ============================================================

-- ── City ────────────────────────────────────────────────────
insert into public.cities (name, state, lat, lng)
values ('Bengaluru', 'Karnataka', 12.971600, 77.594600)
on conflict do nothing;

-- ── Localities ──────────────────────────────────────────────
-- (name, lat, lng, radius_km)
insert into public.localities (city_id, name, lat, lng, radius_km)
select c.id, v.name, v.lat, v.lng, v.radius_km
from (values
  ('Indiranagar',       12.978400, 77.640800, 8.00),
  ('Koramangala',       12.935200, 77.624500, 8.00),
  ('HSR Layout',        12.911600, 77.647400, 8.00),
  ('Jayanagar',         12.925000, 77.593800, 8.00),
  ('Rajajinagar',       12.991500, 77.552000, 8.00),
  ('Malleshwaram',      13.003500, 77.570000, 8.00),
  ('Kalyan Nagar',      13.016700, 77.600000, 8.00),
  ('Whitefield',        12.969800, 77.750000, 10.00),
  ('Marathahalli',      12.959100, 77.697400, 10.00),
  ('Bannerghatta Road', 12.901000, 77.618000, 10.00),
  ('Yelahanka',         13.100700, 77.596300, 10.00),
  ('Electronic City',   12.845200, 77.660200, 12.00)
) as v(name, lat, lng, radius_km)
join public.cities c on lower(c.name) = 'bengaluru' and lower(c.state) = 'karnataka'
on conflict do nothing;

-- ── Categories ──────────────────────────────────────────────
-- (slug, name, icon_key, sort_order)
insert into public.service_categories (name, slug, icon_key, sort_order)
values
  ('Cleaning',  'cleaning',  'Sparkles',      10),
  ('Kitchen',   'kitchen',   'ChefHat',       20),
  ('Laundry',   'laundry',   'Shirt',         30),
  ('Household', 'household', 'House',         40),
  ('Appliance', 'appliance', 'Wrench',        50)
on conflict (slug) do update
  set name       = excluded.name,
      icon_key   = excluded.icon_key,
      sort_order = excluded.sort_order;

-- ── Services ────────────────────────────────────────────────
-- base_price is the HOURLY rate for hourly services, the total for flat
-- services, and the per-unit rate for per_unit services.
insert into public.services
  (category_id, name, slug, short_description, description,
   base_price, pricing_type, unit_label, unit_price,
   min_duration_min, max_duration_min, prep_minutes, max_active_jobs,
   materials_included, materials_note, requires_photo_proof, sort_order)
select
  cat.id, v.name, v.slug, v.short_description, v.description,
  v.base_price, v.pricing_type::public.pricing_type, v.unit_label, v.unit_price,
  v.min_duration_min, v.max_duration_min, v.prep_minutes, v.max_active_jobs,
  v.materials_included, v.materials_note, v.requires_photo_proof, v.sort_order
from (values
  -- Cleaning · hourly 30-240
  ('cleaning', 'Full House Cleaning', 'full-house-cleaning',
   'Deep clean for the whole home — rooms, kitchen, bathrooms and floors.',
   'A trained professional cleans every room in scope: dusting, surface wiping, floor mopping, bathroom and kitchen sanitising, and a final walkthrough with you before they leave. Bring your own supplies unless you opt for the included-materials variant.',
   249.00, 'hourly', null, null, 30, 240, 60, 1, false,
   'Please keep a broom, mop and a dry cloth accessible on each floor.', false, 10),

  ('cleaning', 'Bathroom Cleaning', 'bathroom-cleaning',
   'Tiles, fittings, floors and drains cleaned and sanitised.',
   'Specialist deep clean of one bathroom: floor and joint scrubbing, toilet bowl and exterior, basin, taps and mirror, shower area and glass fittings, and the small fixtures people forget. Ideal as a fortnightly or monthly reset.',
   349.00, 'hourly', null, null, 30, 180, 45, 1, false,
   'Keep cleaning liquids and a cloth within reach of the bathroom.', false, 20),

  ('cleaning', 'Kitchen Deep Clean', 'kitchen-deep-clean',
   'Oils, grease and residue removed from every kitchen surface.',
   'A full kitchen reset: platform, countertop, cabinet fronts, backsplash, sink and drain, stove and chimney exterior, and inside the empty fridge if you have switched it off. One of the highest-demand services on SmartHelp.',
   399.00, 'hourly', null, null, 60, 240, 60, 1, false,
   'Please empty the countertop and switch off the fridge the night before.', false, 30),

  ('cleaning', 'Balcony & Window Cleaning', 'balcony-window-cleaning',
   'Glass, rails, grills and floors in balconies and windows.',
   'Outside surfaces, reached from a balcony with a standard step stool: window glass both sides, frames, sills, railings, grillwork, and a wash-down of the balcony floor. High-reach or rope-access glass is not included.',
   299.00, 'hourly', null, null, 30, 180, 30, 1, false,
   'Remove drying clothes and unlock balcony access before arrival.', false, 40),

  ('cleaning', 'Fan & Appliance Cleaning', 'fan-appliance-cleaning',
   'Ceiling fans, geysers and small appliances cleaned in place.',
   'Dust-off and clean of ceiling and pedestal fans (blade, motor housing, regulator), geyser exterior, mixer and extension boards. Appliances are cleaned where they hang, not dismantled, unless the service detail says otherwise.',
   349.00, 'hourly', null, null, 30, 120, 30, 1, false,
   'Switch off the main breaker to the ceiling fan area before arrival.', false, 50),

  ('cleaning', 'Mopping & Floor Scrubbing', 'mopping-floor-scrubbing',
   'Grout, tile and stone floors scrubbed and machine-mopped.',
   'Floor-only service for homes where the rest is already clean: dry sweeping, scrub-in of grout and joints, and a uniform mop-down with a neutral solution so the floor does not streak. Ideal before a guest arrival or a festival.',
   229.00, 'hourly', null, null, 30, 180, 30, 2, false,
   'Please move furniture you want cleaned under before arrival.', false, 60),

  -- Kitchen · hourly 60-240
  ('kitchen', 'Dishwashing', 'dishwashing',
   'Every dish, pan and utensil washed, dried and put away.',
   'Post-meal or daily-load dishwashing with a sink-side soak, degreasing of the chimney filter, and the dishes dried and stacked back where you keep them. Utensils used for eating are washed separately with a food-safe solution.',
   199.00, 'hourly', null, null, 60, 180, 30, 2, false,
   'Please leave hot pans to cool and rinse before the professional arrives.', false, 70),

  ('kitchen', 'Daily Cooking Support', 'daily-cooking-support',
   'A cook in your kitchen for the prep, the meal and the cleanup.',
   'Support for your own recipes: shopping list and prep, cooking on the stove or in the oven, plating and serving, and washing up afterwards. Ingredients are cooked to your taste and dietary preference. Pantry management and recipe creation are agreed in the booking notes.',
   249.00, 'hourly', null, null, 60, 240, 30, 1, true,
   'Ingredients are included. Please keep a running list of what the cook should buy.', false, 80),

  ('kitchen', 'Vegetable Prep & Chopping', 'vegetable-prep-chopping',
   'Washing, peeling and chopping for a week of cooking.',
   'Bulk prep for a busy household: vegetables washed, peeled, cut and stored; lentils and grains portioned; and the prep area cleaned. Not a cooking service — prep only, ready for you to cook when you want.',
   199.00, 'hourly', null, null, 60, 180, 30, 2, false,
   'Keep storage containers and a labelled box ready for the prepped items.', false, 90),

  ('kitchen', 'Counter & Platform Cleaning', 'counter-platform-cleaning',
   'Kitchen counters, platform and sink scrubbed and degreased.',
   'Every exposed horizontal surface in the kitchen: counter, platform, sink, mixer and chimney exterior, backsplash tiles, and the area behind the gas stove. A fast, high-frequency service for a kitchen that is used daily.',
   199.00, 'hourly', null, null, 60, 180, 30, 2, false,
   'Please move countertop appliances you want cleaned under before arrival.', false, 100),

  ('kitchen', 'Gas Stove & Chimney Wipe-down', 'gas-stove-chimney-wipe',
   'Burners, knobs, chimney and its filter degreased.',
   'Degreasing of the gas stove top, burners, knobs and counter around it, plus the chimney body, glass and the removable filter. The filter is washed, dried and refitted. Deep internal servicing is a different service.',
   249.00, 'hourly', null, null, 60, 120, 30, 1, false,
   'Switch off the stove at the regulator before the professional arrives.', false, 110),

  -- Laundry · per kg or hourly, 60-240
  ('laundry', 'Washing & Dry', 'washing-and-dry',
   'Per kilogram wash, dry and fold, collected from your door.',
   'Sorted, washed, dried and folded laundry billed per kilogram. Common-garment, bedsheet and towel rates are at the per-kilogram rate; delicate and dry-clean-only items are returned untouched and are not billed.',
   45.00, 'per_unit', 'kg', 45.00, 60, 240, 120, 1, true,
   'Detergent is included. A separate laundry bag keeps your colours apart.', false, 120),

  ('laundry', 'Ironing & Folding', 'ironing-and-folding',
   'Per kilogram pressed, folded and sorted by type.',
   'Collected laundry pressed and folded, and returned sorted into your own cupboards or onto a rail. Shirt and trouser creases are set properly; heavier items such as curtains and blankets are quoted before starting.',
   18.00, 'per_unit', 'kg', 18.00, 60, 180, 60, 2, true,
   'An iron and a clean surface are provided. Iron-on embellished items are excluded.', false, 130),

  ('laundry', 'Stain Removal', 'stain-removal',
   'Oil, grease, ink and tea stains worked on the spot.',
   'Per-hour stain treatment for washable garments and household linen: stain identification, pre-treatment, agitation or solvent work, rinse and a dry-off. Heavily set-in or dyed stains may not clear completely; the professional will tell you honestly before starting.',
   299.00, 'hourly', null, null, 60, 180, 60, 1, false,
   'Please check the care label — dry-clean-only items are refused on arrival.', false, 140),

  ('laundry', 'Blanket & Heavy Curtain Wash', 'blanket-curtain-wash',
   'Per piece wash for blankets, comforters and heavy drapes.',
   'Per-piece machine wash and dry for bulky items: cotton and wool blankets, comforters, mattress covers, and heavy blackout or velvet drapes. Pieces are laundered individually and returned dry, folded and covered.',
   120.00, 'per_unit', 'piece', 120.00, 60, 240, 180, 1, true,
   'Detergent is included. Very large drapes are quoted after a photo check.', false, 150),

  -- Household · hourly 60-360
  ('household', 'Decluttering & Organising', 'decluttering-organising',
   'Sort, label, store — the clutter actually leaves the house.',
   'A systematic second pair of hands: sort and categorise, label and store, and dispose of or donate what you no longer want. You decide what leaves; the professional handles the sorting, the labelling and the carrying.',
   299.00, 'hourly', null, null, 60, 360, 60, 1, false,
   'Keep storage boxes, labels and spare hangers ready on the day.', false, 160),

  ('household', 'Moving Help (Packing)', 'moving-help-packing',
   'Packing, labelling and unpacking for a house move.',
   'Two or more professionals for the heavy part of a move: wrapping and packing by room and category, labelling every carton, and reassembly at the other end. Packing material is included; the vehicle and the transport are not.',
   349.00, 'hourly', null, null, 120, 360, 120, 1, true,
   'Bubble wrap, cartons and tape are included. Fragile items are declared in the notes.', true, 170),

  ('household', 'Post-Partition Deep Clean', 'post-partition-deep-clean',
   'A whole-home reset after a move in or a move out.',
   'The heaviest clean on the platform: inside cupboards, ceiling fans, light fittings, window tracks, balcony, and the kitchen and bathrooms in full. Intended for a home that was previously occupied or is being vacated.',
   449.00, 'hourly', null, null, 180, 360, 180, 1, false,
   'Please ensure the home is empty of furniture and the water supply is on.', false, 180),

  ('household', 'Errand & Shopping Run', 'errand-shopping-run',
   'One fixed run: your list, the shops, the doorstep.',
   'A flat-fee run for errands: a shopping list up to 10 kg of provisions, pharmacy pickups, document drop-offs, or returning something across the city. Receipts are shared back with you. Multiple stops are priced by agreement in the notes.',
   199.00, 'flat', null, null, 90, 90, 30, 2, false,
   'No materials needed. Keep the shopping list and any prescription handy.', false, 190),

  -- Appliance · fixed or hourly, 60-180
  ('appliance', 'Refrigerator Deep Clean', 'refrigerator-deep-clean',
   'Shelves, drawers, coils and gasket scrubbed and sanitised.',
   'Unplugged, emptied, and cleaned inside and out: shelves, drawers, door gasket, interior walls, the condenser coil and the back panel, then deodorised and dried. Food must be removed and transported by you.',
   599.00, 'flat', null, null, 120, 120, 60, 1, false,
   'Please empty the refrigerator and store the food elsewhere before arrival.', true, 200),

  ('appliance', 'Microwave Clean', 'microwave-clean',
   'Interior, glass turntable and door seal degreased.',
   'The microwave is cleaned inside and out: cavity, ceiling and floor, glass turntable, waveguide cover, door seal and the outer body, then deodorised. Leftover spills and reheated odours are the usual reason for booking.',
   349.00, 'flat', null, null, 60, 60, 30, 1, false,
   'Please unplug the microwave before the professional arrives.', true, 210),

  ('appliance', 'Air Conditioner Service', 'air-conditioner-service',
   'Filter clean, coil wash, full function check.',
   'A service visit for split and window AC: filter removal and clean, indoor unit coil wash, drain line flush, and a full function check with a temperature reading. Refrigerant top-up, if needed, is quoted separately and in advance.',
   899.00, 'flat', null, null, 90, 90, 60, 1, false,
   'The unit must be accessible and the AC switched off at the isolator.', true, 220),

  ('appliance', 'Chimney Deep Clean', 'chimney-deep-clean',
   'Filters, motor and duct interior degreased.',
   'A proper chimney clean: both removable filters washed, the impeller and motor housing degreased, the interior duct and hood walls wiped down, and the unit reassembled and tested. Kitchen grease, not a wipe-down.',
   799.00, 'flat', null, null, 90, 90, 60, 1, false,
   'Please keep the chimney switch accessible and clear the platform below it.', true, 230)
) as v(cat_slug, name, slug, short_description, description,
       base_price, pricing_type, unit_label, unit_price,
       min_duration_min, max_duration_min, prep_minutes, max_active_jobs,
       materials_included, materials_note, requires_photo_proof, sort_order)
join public.service_categories cat on cat.slug = v.cat_slug
on conflict (slug) do update
  set category_id          = excluded.category_id,
      name                 = excluded.name,
      short_description    = excluded.short_description,
      description          = excluded.description,
      base_price           = excluded.base_price,
      pricing_type         = excluded.pricing_type,
      unit_label           = excluded.unit_label,
      unit_price           = excluded.unit_price,
      min_duration_min     = excluded.min_duration_min,
      max_duration_min     = excluded.max_duration_min,
      prep_minutes         = excluded.prep_minutes,
      max_active_jobs      = excluded.max_active_jobs,
      materials_included   = excluded.materials_included,
      materials_note       = excluded.materials_note,
      requires_photo_proof = excluded.requires_photo_proof,
      sort_order           = excluded.sort_order;

-- ── Duration ladder ─────────────────────────────────────────
-- Default ladder: 30, 45, 60, 90, 120, 180, 240, 300, 360 minutes.
-- A row may carry a flat `price` OR a `price_multiplier`, never both.
-- Flat-priced services get exactly one row: the time the job takes.
insert into public.service_durations (service_id, minutes, price_multiplier)
select s.id, v.minutes, v.price_multiplier::numeric
from (values
  (30,  0.600), (45,  0.850), (60,  1.000), (90,  1.350),
  (120, 1.700), (180, 2.400), (240, 3.100), (300, 3.800), (360, 4.500)
) as v(minutes, price_multiplier)
join public.services s
  on s.pricing_type = 'hourly'
 and v.minutes between s.min_duration_min and s.max_duration_min
on conflict (service_id, minutes) do update
  set price_multiplier = excluded.price_multiplier,
      is_active = true;

-- Flat-priced services: one row, no ladder, no multiplier.
insert into public.service_durations (service_id, minutes, price)
select s.id, s.max_duration_min, s.base_price
from public.services s
where s.pricing_type = 'flat'
on conflict (service_id, minutes) do update
  set price = excluded.price,
      is_active = true;

-- Per-unit services are priced on the weight or the piece, but the
-- professional still spends time: give them the standard ladder.
insert into public.service_durations (service_id, minutes, price_multiplier)
select s.id, v.minutes, v.price_multiplier::numeric
from (values
  (60, 1.000), (90, 1.350), (120, 1.700), (180, 2.400), (240, 3.100)
) as v(minutes, price_multiplier)
join public.services s
  on s.pricing_type = 'per_unit'
 and v.minutes between s.min_duration_min and s.max_duration_min
on conflict (service_id, minutes) do nothing;

-- ── Scope contract (service_tasks) ──────────────────────────
-- The ✓ included / ✕ excluded list on the service detail screen. A
-- dispute is adjudicated against these rows, so they are written as
-- specific, checkable statements — never "general cleaning".
insert into public.service_tasks (service_id, kind, label, sort_order)
select s.id, v.kind, v.label, v.sort_order
from (values
  -- Bathroom Cleaning: the canonical example from the specification
  ('bathroom-cleaning', 'included', 'Floor cleaning (tiles, joints, drains)', 10),
  ('bathroom-cleaning', 'included', 'Toilet bowl, seat, exterior & flush cleaning', 20),
  ('bathroom-cleaning', 'included', 'Basin, taps, mirror & tap stains', 30),
  ('bathroom-cleaning', 'included', 'Shower area, glass & fittings', 40),
  ('bathroom-cleaning', 'included', 'Soap dish, holder, tissue, door handle', 50),
  ('bathroom-cleaning', 'excluded', 'Hazardous / bleach chemical deep treatment', 60),
  ('bathroom-cleaning', 'excluded', 'Outdoor or high-reach glass cleaning', 70),
  ('bathroom-cleaning', 'excluded', 'Moving heavy or fixed furniture', 80),
  ('bathroom-cleaning', 'excluded', 'Construction stain / paint removal', 90),

  ('full-house-cleaning', 'included', 'Dust-off of all surfaces, ledges and shelves', 10),
  ('full-house-cleaning', 'included', 'Mopping and wiping of all floors', 20),
  ('full-house-cleaning', 'included', 'Kitchen counter, platform and sink cleaning', 30),
  ('full-house-cleaning', 'included', 'Bathroom fixtures and floors', 40),
  ('full-house-cleaning', 'included', 'Beds, mattress top and side surfaces', 50),
  ('full-house-cleaning', 'included', 'Dustbins emptied and relined', 60),
  ('full-house-cleaning', 'excluded', 'Inside the refrigerator or oven', 70),
  ('full-house-cleaning', 'excluded', 'Interior of cupboards and wardrobe shelves', 80),
  ('full-house-cleaning', 'excluded', 'Window glass outside, from a rope or a high ledge', 90),
  ('full-house-cleaning', 'excluded', 'Pest control, termite treatment or shampooing', 100),

  ('kitchen-deep-clean', 'included', 'Platform, counter and backsplash degreasing', 10),
  ('kitchen-deep-clean', 'included', 'Cabinet doors and handles, outside surfaces', 20),
  ('kitchen-deep-clean', 'included', 'Sink, drain and the area under the sink', 30),
  ('kitchen-deep-clean', 'included', 'Gas stove, burners, knobs and surrounding counter', 40),
  ('kitchen-deep-clean', 'included', 'Chimney exterior, glass and filter', 50),
  ('kitchen-deep-clean', 'excluded', 'Duct interior beyond the filter', 60),
  ('kitchen-deep-clean', 'excluded', 'Refrigerator interior (a separate service)', 70),
  ('kitchen-deep-clean', 'excluded', 'Repainting, retiling or re-grouting', 80),

  ('daily-cooking-support', 'included', 'Shopping and ingredient preparation', 10),
  ('daily-cooking-support', 'included', 'Cooking your recipes on the stove or in the oven', 20),
  ('daily-cooking-support', 'included', 'Plating and serving', 30),
  ('daily-cooking-support', 'included', 'Washing up and cleaning of the cooking area', 40),
  ('daily-cooking-support', 'excluded', 'Baking cakes, bread or pastries', 50),
  ('daily-cooking-support', 'excluded', 'Dietary planning or nutrition advice', 60),
  ('daily-cooking-support', 'excluded', 'Serving non-vegetarian food without prior agreement', 70),

  ('washing-and-dry', 'included', 'Sorting, washing and drying', 10),
  ('washing-and-dry', 'included', 'Folding and bagging by category', 20),
  ('washing-and-dry', 'excluded', 'Dry cleaning or steam ironing of special fabrics', 30),
  ('washing-and-dry', 'excluded', 'Stain removal above 30 minutes (a separate service)', 40),

  ('ironing-and-folding', 'included', 'Ironing and creasing of foldable garments', 10),
  ('ironing-and-folding', 'included', 'Sorting and folding by type', 20),
  ('ironing-and-folding', 'excluded', 'Iron-on embellishments, velvet and wool coats', 30),

  ('refrigerator-deep-clean', 'included', 'Shelves, drawers and interior walls', 10),
  ('refrigerator-deep-clean', 'included', 'Door gasket and seal cleaned', 20),
  ('refrigerator-deep-clean', 'included', 'Condenser coil and back panel dust-off', 30),
  ('refrigerator-deep-clean', 'excluded', 'Compressor repair or gas refilling', 40),
  ('refrigerator-deep-clean', 'excluded', 'Disposal of the food you removed', 50),

  ('air-conditioner-service', 'included', 'Filter removal, clean and refit', 10),
  ('air-conditioner-service', 'included', 'Indoor unit coil wash', 20),
  ('air-conditioner-service', 'included', 'Drain line flush', 30),
  ('air-conditioner-service', 'included', 'Full function check with a temperature reading', 40),
  ('air-conditioner-service', 'excluded', 'Refrigerant top-up (quoted separately, in advance)', 50),
  ('air-conditioner-service', 'excluded', 'Outdoor unit, installation or shifting', 60),

  ('post-partition-deep-clean', 'included', 'Inside cupboards, almirahs and wardrobe shelves', 10),
  ('post-partition-deep-clean', 'included', 'Ceiling fans and light fittings', 20),
  ('post-partition-deep-clean', 'included', 'Window tracks, sills and glass from the inside', 30),
  ('post-partition-deep-clean', 'included', 'Balcony, walls and skirting boards', 40),
  ('post-partition-deep-clean', 'included', 'Full kitchen and bathroom clean', 50),
  ('post-partition-deep-clean', 'excluded', 'Paint, whitewash and wall treatment', 60),
  ('post-partition-deep-clean', 'excluded', 'Carpets, sofa and mattress shampooing', 70),
  ('post-partition-deep-clean', 'excluded', 'Removal and disposal of furniture or debris', 80)
) as v(slug, kind, label, sort_order)
join public.services s on s.slug = v.slug
on conflict do nothing;

-- ── Service areas (coverage) ────────────────────────────────
-- A service is bookable only where an active service_areas row exists.
-- The ten core localities carry the full catalogue; the three outer
-- localities carry Cleaning and Kitchen only, so the
-- SERVICE_UNAVAILABLE path (§25.2) is reachable with real data.
insert into public.service_areas (locality_id, service_id, lead_minutes, slot_capacity)
select l.id, s.id,
       greatest(s.prep_minutes, case when l.name in ('Electronic City','Yelahanka') then 45 else 0 end),
       case when l.name in ('Electronic City','Yelahanka','Bannerghatta Road') then 2 else 4 end
from public.localities l
join public.cities c on c.id = l.city_id
join public.services s on true
join public.service_categories cat on cat.id = s.category_id
where lower(c.name) = 'bengaluru'
  and (l.name not in ('Electronic City','Yelahanka','Bannerghatta Road')
       or cat.slug in ('cleaning','kitchen'))
on conflict (locality_id, service_id) do update
  set lead_minutes  = excluded.lead_minutes,
      slot_capacity = excluded.slot_capacity,
      is_active     = true;
