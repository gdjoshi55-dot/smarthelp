import { describe, expect, it } from 'vitest';
import {
  directionsUrl,
  parseAddressComponents,
  placeUrl,
  type AddressComponentLike,
} from '@/lib/googleMapsAddress';

const placeStyle: AddressComponentLike[] = [
  { longText: '12', shortText: '12', types: ['street_number'] },
  { longText: '4th Cross Road', shortText: '4th Cross Rd', types: ['route'] },
  { longText: 'Indiranagar', shortText: 'Indiranagar', types: ['sublocality_level_1'] },
  { longText: 'Bengaluru', shortText: 'Bengaluru', types: ['locality'] },
  { longText: 'Karnataka', shortText: 'KA', types: ['administrative_area_level_1'] },
  { longText: '560038', shortText: '560038', types: ['postal_code'] },
];

const geocoderStyle: AddressComponentLike[] = [
  { long_name: '12', short_name: '12', types: ['street_number'] },
  { long_name: '4th Cross Road', short_name: '4th Cross Rd', types: ['route'] },
  { long_name: 'Indiranagar', short_name: 'Indiranagar', types: ['sublocality_level_1'] },
  { long_name: 'Bengaluru', short_name: 'Bengaluru', types: ['locality'] },
  { long_name: 'Karnataka', short_name: 'KA', types: ['administrative_area_level_1'] },
  { long_name: '560038', short_name: '560038', types: ['postal_code'] },
];

describe('parseAddressComponents', () => {
  it('maps Places (New) longText components onto the address fields', () => {
    const parsed = parseAddressComponents(placeStyle, '12, 4th Cross Road, Indiranagar, Bengaluru, Karnataka 560038');
    expect(parsed).toEqual({
      line1: '12 4th Cross Road',
      line2: '',
      area: 'Indiranagar',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560038',
    });
  });

  it('maps Geocoder long_name components the same way', () => {
    const parsed = parseAddressComponents(geocoderStyle, '');
    expect(parsed.line1).toBe('12 4th Cross Road');
    expect(parsed.area).toBe('Indiranagar');
    expect(parsed.city).toBe('Bengaluru');
    expect(parsed.state).toBe('Karnataka');
    expect(parsed.pincode).toBe('560038');
  });

  it('puts a distinct premise on the second line', () => {
    const parsed = parseAddressComponents(
      [
        { longText: '12', types: ['street_number'] },
        { longText: '4th Cross Road', types: ['route'] },
        { longText: 'Prestige Towers', types: ['premise'] },
        { longText: 'Indiranagar', types: ['sublocality_level_1'] },
        { longText: 'Bengaluru', types: ['locality'] },
        { longText: 'Karnataka', types: ['administrative_area_level_1'] },
        { longText: '560038', types: ['postal_code'] },
      ],
      ''
    );
    expect(parsed.line1).toBe('12 4th Cross Road');
    expect(parsed.line2).toBe('Prestige Towers');
  });

  it('falls back to the formatted address when components are missing', () => {
    const parsed = parseAddressComponents(
      [],
      '12, 4th Cross, Indiranagar, Bengaluru, Karnataka 560038'
    );
    expect(parsed.line1).toBe('12, 4th Cross');
    expect(parsed.area).toBe('Indiranagar');
    expect(parsed.city).toBe('Bengaluru');
    expect(parsed.state).toBe('Karnataka');
    expect(parsed.pincode).toBe('560038');
  });

  it('does not invent a pincode when Google did not return one', () => {
    const parsed = parseAddressComponents([], '12, 4th Cross, Indiranagar, Bengaluru');
    expect(parsed.pincode).toBe('');
  });

  it('uses the place name as the first line when the pin is on a named place', () => {
    const parsed = parseAddressComponents(
      [
        { longText: 'Indiranagar', types: ['sublocality_level_1'] },
        { longText: 'Bengaluru', types: ['locality'] },
        { longText: 'Karnataka', types: ['administrative_area_level_1'] },
        { longText: '560038', types: ['postal_code'] },
      ],
      '',
      'Prestige Towers'
    );
    expect(parsed.line1).toBe('Prestige Towers');
  });
});

describe('directionsUrl', () => {
  it('opens Google Maps directions to the destination', () => {
    const url = new URL(directionsUrl({ lat: 12.9716, lng: 77.5946 }));
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/dir/');
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('destination')).toBe('12.9716,77.5946');
    expect(url.searchParams.get('travelmode')).toBe('driving');
  });

  it('includes an origin and travel mode when supplied', () => {
    const url = new URL(
      directionsUrl(
        { lat: 12.9, lng: 77.5 },
        { origin: { lat: 12.8, lng: 77.4 }, travelMode: 'walking' }
      )
    );
    expect(url.searchParams.get('origin')).toBe('12.8,77.4');
    expect(url.searchParams.get('travelmode')).toBe('walking');
  });
});

describe('placeUrl', () => {
  it('opens a pin, using the label when there is one', () => {
    const url = new URL(placeUrl({ lat: 12.9, lng: 77.5 }, 'Home'));
    expect(url.searchParams.get('query')).toBe('Home 12.9,77.5');
  });
});
