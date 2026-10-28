# Google Maps integration

SmartHelp uses the Google Maps Platform for every map in the product:

- **Address picker** — search for a building/street/area, tap the map, or drag a
  pin. The pin is reverse-geocoded into the address form's fields.
- **Live tracking** — the customer sees the professional's last reported pin and
  the service address; the professional sees the job address.
- **Navigation** — every "Navigate" action is a Google Maps universal link, which
  opens the Maps app on a phone and the Maps site on a desktop. It does not call
  or bill the Directions API.

There is no Leaflet/OpenStreetMap code left; Google Maps is the only map
provider.

## What to enable

In the Google Cloud project that owns the API key:

| Google API | Used for |
|---|---|
| **Maps JavaScript API** | Rendering the picker and tracking maps (`Dynamic Maps`) |
| **Places API (New)** | Address autocomplete and the selected place's components |
| **Geocoding API** | Turning a dragged/clicked pin into an address |

Do **not** enable Static Maps, Street View, Embed, or the Android/iOS Maps SDK for
this web app — nothing here calls them.

> Places API (New), not the legacy Places API. The legacy Autocomplete widget is
> closed to new customers, and the implementation uses
> `AutocompleteSuggestion` with a session token so that one search plus its
> selection is billed as one session.

## 1. Create the key

1. Open **Google Cloud Console → APIs & Services → Credentials**.
2. Create an **API key**.
3. **Application restrictions → HTTP referrers**:
   - `http://localhost:3000/*` for local development
   - `https://your-production-domain/*` once deployed
4. **API restrictions → Restrict key** and select only:
   - Maps JavaScript API
   - Places API (New)
   - Geocoding API

The key is a browser key and is visible in the bundle by design. The referrer
and API restrictions are the security control. Never put a server key or a
service-account credential in a `NEXT_PUBLIC_*` variable.

## 2. Set the environment

```env
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=AIza...
NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=          # optional
NEXT_PUBLIC_GOOGLE_MAPS_REGION=IN
NEXT_PUBLIC_GOOGLE_MAPS_LANGUAGE=en
```

- Without `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, maps render a small "Map is not
  configured" notice and the manual address fields still work. Checkout does not
  break.
- `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` enables vector maps and Advanced Markers. The
  code falls back to Google's `DEMO_MAP_ID`, which is fine for development but
  shows a watermark and is not for production. Create a Map ID at **Google Maps
  Platform → Map Management → Create Map ID** (JavaScript, Vector).

## 3. Free-tier and cost controls

Google Maps Platform is pay-as-you-go with monthly free usage per SKU. Billing
must be enabled even when usage stays inside the free caps.

The SKUs shown in the account this project was configured for:

| SKU | Free usage cap |
|---|---|
| Dynamic Maps (India) | 70,000 / month |
| Embed (India) | Unlimited |
| Maps SDK (India) | Unlimited |
| Static Maps (India) | 70,000 / month |
| Static Street View (India) | 70,000 / month |
| Street View Metadata (India) | Unlimited |

What this app actually uses:

| Feature | API / SKU | Notes |
|---|---|---|
| Address picker map | Maps JavaScript API → Dynamic Maps | One map load per address-form visit |
| Live tracking map | Maps JavaScript API → Dynamic Maps | One map load per booking/job page |
| Address search | Places API (New) → Autocomplete Requests | Debounced; only after 3 characters |
| Selected place | Places API (New) → Place Details | One call per chosen suggestion |
| Pin → address text | Geocoding API → Geocoding | Only on explicit click, drag-end, or "Use my location"; cached by pin |
| Navigate | Google Maps URLs | No API call, no SKU |
| Static Maps / Street View / Embed | **Not used** | Can stay disabled |

Places and Geocoding are metered under their own SKUs in the Cloud console, not
under the map-load SKU above. Confirm their current free caps on the **Quotas**
and **Billing** pages before launch.

### Cap the spend in the console

1. **Google Maps Platform → Quotas**: set a daily quota for each enabled SKU just
   below the free monthly cap. For example, `70,000 / 30 ≈ 2,300` Dynamic Maps
   requests per day, or leave headroom and set a lower number.
2. **Billing → Budgets & alerts**: create a budget of ₹0 (or a small amount) with
   alerts at 50%, 90% and 100%.
3. Review **Google Maps Platform → Metrics** weekly during the first month.

### What the code does to reduce calls

- Autocomplete is debounced 300 ms and does not run until 3 characters.
- A reverse geocode runs only when the user places or drags the pin, and the
  result is cached per rounded coordinate.
- Autocomplete and Place Details share one session token, so a search + selection
  is one session rather than two unrelated requests.
- Map libraries (`places`, `marker`) load on demand; the script loads once per
  tab.
- Navigation uses universal links rather than the Directions API.
- No Static Maps, Street View, or Embed requests are made.

## 4. How the flow works

1. The customer reaches checkout with no saved address and sees `AddressForm`.
2. `AddressMapPicker` loads the map and search box.
3. Typing calls Places Autocomplete (New). Choosing a result calls
   `Place.fetchFields({ fields: ['formattedAddress', 'location',
   'addressComponents', 'displayName'] })`.
4. Tapping the map or dragging the pin calls `Geocoder.geocode({ location })`.
5. `parseAddressComponents` maps Google's result onto `line1`, `line2`, `area`,
   `city`, `state`, `pincode` and fills the form. The customer can edit every
   field and add a landmark/access note.
6. Saving posts `lat`/`lng` with the address. The server stores the exact point
   (`location_precision: 'exact'`) and resolves the service locality.
7. On the professional's job page, **Navigate** opens
   `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`.
8. On the customer's booking page, the tracking map updates the professional's
   marker in place every 15 seconds; the camera does not chase the marker.
9. The customer's **Arriving in** card shows the driving duration and distance
   from the same Routes API call that drew the route. Until that call finishes,
   it falls back to the server's straight-line distance estimate.

If the customer edits `area`, `city`, `state` or `pincode` by hand after placing
a pin, the pin is cleared so the saved coordinates cannot disagree with the typed
address. The server then falls back to the locality centre and reports
`location_precision: 'locality_centre'`.

## 5. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Grey map, "This page didn't load Google Maps correctly" | Billing not enabled, wrong key, or Maps JavaScript API not enabled |
| Autocomplete returns nothing / error in console | Places API (New) not enabled or blocked by key restrictions |
| Pin moves but no address appears | Geocoding API not enabled or quota exhausted |
| Watermark "For development purposes only" on the map | Missing Map ID, or billing/key restrictions |
| `RefererNotAllowedMapError` | The current origin is not in the key's HTTP referrer list |
| `ApiNotActivatedMapError` | The requested API is not enabled in the project |

The UI shows the Google error message if a library call fails; the rest of the
address form remains usable.

## 6. Production checklist

- [ ] Billing enabled on the Cloud project.
- [ ] Maps JavaScript API, Places API (New) and Geocoding API enabled.
- [ ] Key restricted to those three APIs and to production + localhost referrers.
- [ ] Real Map ID created and `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` set.
- [ ] Daily quotas and budget alerts configured.
- [ ] One real checkout tested: search, pick, drag, save, book.
- [ ] One real job tested: professional opens **Navigate** and reaches the pin.

## Local verification

```bash
npm run dev
```

Sign in as a customer with no saved address, add a service, continue to checkout,
then search for an address. The pin should move, the fields should fill, and
saving should succeed. Without an API key the map shows a configuration notice,
which is the intended fallback rather than a crash.
