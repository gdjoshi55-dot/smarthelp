/**
 * Address parsing for the Google Maps picker.
 *
 * Google returns two different shapes for the same facts: the Geocoder uses
 * `long_name` / `short_name`, while Places (New) uses `longText` / `shortText`.
 * Both are normalised here so the form that consumes a picked place does not
 * care which API produced it.
 *
 * The module is deliberately pure and independent of the `google` namespace so
 * it can be unit-tested in Node without a browser or an API key. It is also the
 * only place that decides how a Google result maps onto SmartHelp's address
 * fields: `line1`, `line2`, `area`, `city`, `state`, `pincode`.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface AddressComponentLike {
  long_name?: string | null;
  short_name?: string | null;
  longText?: string | null;
  shortText?: string | null;
  types?: string[];
}

export interface ParsedAddress {
  line1: string;
  line2: string;
  area: string;
  city: string;
  state: string;
  pincode: string;
}

export interface AddressSelection extends ParsedAddress {
  lat: number;
  lng: number;
  formattedAddress: string;
  placeId?: string;
}

const EMPTY: ParsedAddress = {
  line1: '',
  line2: '',
  area: '',
  city: '',
  state: '',
  pincode: '',
};

function longName(component: AddressComponentLike | undefined): string {
  return (component?.longText ?? component?.long_name ?? '').trim();
}

function shortName(component: AddressComponentLike | undefined): string {
  return (component?.shortText ?? component?.short_name ?? '').trim();
}

function find(
  components: AddressComponentLike[],
  type: string
): AddressComponentLike | undefined {
  return components.find((component) => component.types?.includes(type));
}

function first(
  components: AddressComponentLike[],
  types: string[]
): AddressComponentLike | undefined {
  for (const type of types) {
    const hit = find(components, type);
    if (hit) return hit;
  }
  return undefined;
}

/** Collapses repeated whitespace and trims, so a joined line cannot double-space. */
function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function join(...parts: Array<string | null | undefined>): string {
  return clean(parts.filter((part): part is string => !!part && part.trim().length > 0).join(' '));
}

/**
 * Splits a formatted address when the structured components are absent.
 *
 * This is a fallback, not the main path: Indian formatted addresses are usually
 * `street, area, city, state pincode`, so the last part carries the pincode and
 * the one before it the state. It deliberately keeps whole parts rather than
 * guessing at commas inside a locality name.
 */
function fromFormattedAddress(formatted: string): ParsedAddress {
  const parts = formatted
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ...EMPTY };

  const last = parts[parts.length - 1] ?? '';
  const pincode = last.match(/\b([0-9]{6})\b/)?.[1] ?? '';
  const statePart = pincode ? last.replace(pincode, '').trim() : '';
  const withoutPincode = pincode ? parts.slice(0, -1) : [...parts];
  const state = statePart || (withoutPincode.length >= 2 ? withoutPincode.pop() ?? '' : '');
  const city = withoutPincode.length >= 1 ? withoutPincode.pop() ?? '' : '';
  const area = withoutPincode.length >= 1 ? withoutPincode.pop() ?? '' : '';
  const line1 = withoutPincode.join(', ');

  return {
    line1: clean(line1 || parts[0] || ''),
    line2: '',
    area: clean(area),
    city: clean(city),
    state: clean(state),
    pincode,
  };
}

/**
 * Maps Google's components onto the six fields the address form saves.
 *
 * The hierarchy is the one SmartHelp's locality matching understands:
 *
 * - `line1` is the door: street number and route, or the named place/building
 *   when the pin is on a premise rather than a road.
 * - `line2` is the additional building/floor line. It is only filled when it is
 *   genuinely distinct from `line1`.
 * - `area` prefers `sublocality_level_1`, then neighbourhood, then locality.
 *   That is the granularity `localities` is keyed on.
 * - `city` is `locality`, falling back to the district.
 * - `pincode` is `postal_code`; a missing one is left blank for the human to
 *   complete rather than invented.
 */
export function parseAddressComponents(
  components: AddressComponentLike[],
  formattedAddress = '',
  fallbackName = ''
): ParsedAddress {
  if (!components || components.length === 0) {
    const fallback = fromFormattedAddress(formattedAddress);
    if (!fallback.line1 && fallbackName) fallback.line1 = clean(fallbackName);
    return fallback;
  }

  const streetNumber = longName(first(components, ['street_number']));
  const route = longName(first(components, ['route']));
  const subpremise = longName(first(components, ['subpremise']));
  const premise = longName(first(components, ['premise', 'point_of_interest']));

  const street = join(streetNumber, route);
  const building = join(subpremise, premise);
  const line1 = street || building || clean(fallbackName);
  const line2 = building && building !== line1 && !street.includes(building) ? building : '';

  const areaComponent = first(components, [
    'sublocality_level_1',
    'sublocality_level_2',
    'sublocality',
    'neighborhood',
    'locality',
    'administrative_area_level_3',
  ]);
  const cityComponent = first(components, ['locality', 'administrative_area_level_2']);
  const stateComponent = first(components, ['administrative_area_level_1']);
  const pincodeComponent = first(components, ['postal_code']);

  const parsed: ParsedAddress = {
    line1: clean(line1),
    line2: clean(line2),
    area: longName(areaComponent),
    city: longName(cityComponent),
    state: longName(stateComponent),
    pincode: shortName(pincodeComponent) || longName(pincodeComponent),
  };

  // Fill only the gaps from the formatted string. A component that Google did
  // return is always preferred to a comma split of the same fact.
  if (!parsed.line1 || !parsed.area || !parsed.city || !parsed.state || !parsed.pincode) {
    const fallback = fromFormattedAddress(formattedAddress);
    parsed.line1 = parsed.line1 || fallback.line1;
    parsed.line2 = parsed.line2 || fallback.line2;
    parsed.area = parsed.area || fallback.area;
    parsed.city = parsed.city || fallback.city;
    parsed.state = parsed.state || fallback.state;
    parsed.pincode = parsed.pincode || fallback.pincode;
  }

  if (!parsed.line1 && fallbackName) parsed.line1 = clean(fallbackName);
  return parsed;
}

/**
 * A deep link that opens Google Maps directions.
 *
 * A universal link rather than the Directions API: on a phone it opens the
 * Google Maps app, on a desktop it opens the site, and neither costs a billable
 * API request. The professional's destination is the one thing they need.
 */
export function directionsUrl(
  destination: LatLng,
  options: { origin?: LatLng | null; travelMode?: 'driving' | 'walking' | 'bicycling' | 'transit' } = {}
): string {
  const params = new URLSearchParams({
    api: '1',
    destination: `${destination.lat},${destination.lng}`,
    travelmode: options.travelMode ?? 'driving',
  });
  if (options.origin) {
    params.set('origin', `${options.origin.lat},${options.origin.lng}`);
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** A link to one pin, for "open this address in Google Maps". */
export function placeUrl(point: LatLng, label?: string): string {
  const query = label
    ? `${label} ${point.lat},${point.lng}`
    : `${point.lat},${point.lng}`;
  return `https://www.google.com/maps/search/?${new URLSearchParams({
    api: '1',
    query,
  }).toString()}`;
}
