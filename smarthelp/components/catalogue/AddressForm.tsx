'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { Loader2, MapPin, MapPinPlus, X } from 'lucide-react';
import {
  AddressApiError,
  createAddress,
  type AddressTypeInput,
  type CreateAddressResult,
} from '@/lib/addressClient';
import type { AddressSelection, LatLng } from '@/lib/googleMapsAddress';
import { usePublicLocation } from './PublicLocationContext';

/**
 * The picker is client-only: Google Maps touches `window` at import time.
 * Keeping it out of the server bundle also keeps the map script off every page
 * that merely imports the address form.
 */
const AddressMapPicker = dynamic(() => import('@/components/map/AddressMapPicker'), {
  ssr: false,
  loading: () => (
    <div className="flex h-56 items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-500">
      Loading the map…
    </div>
  ),
});

/**
 * Save an address, for a customer who has none to save (§5.2).
 *
 * Phase 1 built `POST /api/customers/me/addresses`, the RLS, and the `addressId`
 * the booking routes read — and no component ever called it. Checkout requires an
 * `addressId`, so a signed-in customer with zero saved addresses reached a screen
 * whose Confirm button was permanently disabled and whose only other element was
 * the sentence "Pick a saved address to continue." Nothing had gone wrong on the
 * server; there was simply nothing on the page that could reach it.
 *
 * ## Why the address is selected on the way out
 *
 * `selectAddress` rather than a callback that asks the parent to. `addressId` in
 * `PublicLocationContext` is what `CheckoutForm`'s Confirm button reads, so
 * selecting here is what makes the booking possible — a form that reported success
 * and left the selection alone would show a saved address and a dead button.
 *
 * ## Why these checks restate `validateAddressInput`
 *
 * The server is the authority, and it is the only one of the two that cannot be
 * skipped. These copies exist so a round trip is not the first line of defence: a
 * four-digit pincode should not cost a request to find out, and a message under
 * the input is only possible if the failure was anticipated. They are keyed by the
 * *wire* field name, because that is what the server fails with — `access_notes`,
 * `address_type` — and a form that renamed them would need a second mapping to put
 * each message under the right box.
 *
 * The one thing this cannot do is check the area is real. `resolveLocationForSave`
 * refuses an address it cannot place in a service area, and that answer arrives as
 * `fields.area`; so the hint says what the area is *for* rather than asking for a
 * locality from a list this form has no way of fetching.
 */

interface Fields {
  label: string;
  addressType: AddressTypeInput;
  line1: string;
  line2: string;
  area: string;
  city: string;
  state: string;
  pincode: string;
  landmark: string;
  accessNotes: string;
}

/** §5.2's field list, with the server's own defaults. */
const EMPTY: Fields = {
  label: 'Home',
  addressType: 'home',
  line1: '',
  line2: '',
  area: '',
  city: '',
  state: '',
  pincode: '',
  landmark: '',
  accessNotes: '',
};

const INPUT =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100';

function check(fields: Fields): Record<string, string> {
  const errors: Record<string, string> = {};
  if (fields.line1.trim().length === 0) {
    errors.line1 = 'Enter the flat or house number and the street';
  }
  if (fields.area.trim().length < 2) errors.area = 'Enter the area or locality';
  if (fields.city.trim().length < 2) errors.city = 'Enter the city';
  if (fields.state.trim().length < 2) errors.state = 'Enter the state';
  if (!/^[0-9]{6}$/.test(fields.pincode.trim())) errors.pincode = 'Enter a six-digit pincode';
  return errors;
}

function Field({
  id,
  label,
  error,
  required = false,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-gray-700">
        {label}
        {required ? <span className="text-gray-400"> (required)</span> : null}
      </label>
      <div className="mt-1">{children}</div>
      {error ? (
        <p className="mt-1 text-xs text-red-700">{error}</p>
      ) : null}
    </div>
  );
}

export function AddressForm({
  onCreated,
  onCancel,
}: {
  onCreated?: (created: CreateAddressResult) => void;
  onCancel?: () => void;
}) {
  const { selectAddress } = usePublicLocation();
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [point, setPoint] = useState<LatLng | null>(null);
  const [pinProblem, setPinProblem] = useState<string | null>(null);

  // Editing an identity field after the pin was placed would leave the saved
  // point vouching for a different area. Drop the pin rather than save a pair
  // that disagrees with the address beside it.
  const clearsPin: Array<keyof Fields> = ['area', 'city', 'state', 'pincode'];

  const set = (key: keyof Fields) => (value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
    if (point && clearsPin.includes(key)) {
      setPoint(null);
      setPinProblem('Address edited by hand, so the map pin was cleared. Pick it again to keep an exact location.');
    }
  };

  /**
   * A place chosen on the map replaces the fields Google knows, and keeps the
   * ones only the customer can supply (`landmark`, `access_notes`, the label).
   * Empty values never overwrite something already typed.
   */
  function applySelection(selection: AddressSelection) {
    setPoint({ lat: selection.lat, lng: selection.lng });
    setPinProblem(null);
    setFields((current) => ({
      ...current,
      line1: selection.line1 || current.line1,
      line2: selection.line2 || current.line2,
      area: selection.area || current.area,
      city: selection.city || current.city,
      state: selection.state || current.state,
      pincode: selection.pincode || current.pincode,
    }));
    setErrors((current) => {
      const next = { ...current };
      if (selection.line1) delete next.line1;
      if (selection.area) delete next.area;
      if (selection.city) delete next.city;
      if (selection.state) delete next.state;
      if (selection.pincode) delete next.pincode;
      return next;
    });
  }

  async function save() {
    const found = check(fields);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setProblem(null);
    try {
      const created = await createAddress({
        line1: fields.line1.trim(),
        area: fields.area.trim(),
        city: fields.city.trim(),
        state: fields.state.trim(),
        pincode: fields.pincode.trim(),
        addressType: fields.addressType,
        ...(fields.label.trim() ? { label: fields.label.trim() } : {}),
        ...(fields.line2.trim() ? { line2: fields.line2.trim() } : {}),
        ...(fields.landmark.trim() ? { landmark: fields.landmark.trim() } : {}),
        ...(fields.accessNotes.trim() ? { accessNotes: fields.accessNotes.trim() } : {}),
        ...(point ? { lat: point.lat, lng: point.lng } : {}),
      });
      // Selected first: see the note at the top of the file.
      selectAddress(created.address.id);
      onCreated?.(created);
    } catch (e) {
      if (e instanceof AddressApiError) {
        setProblem(e.message);
        // The server names the field it refused, so each message lands under its
        // own input rather than in one banner above a form of empty boxes.
        if (e.fields) setErrors(e.fields);
      } else {
        setProblem('We could not save this address.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <MapPinPlus className="h-4 w-4 text-gray-400" aria-hidden="true" />
        Save an address to continue
      </p>
      <p className="mt-1 text-xs text-gray-600">
        Your booking is written against an address on your account, so a professional can be sent
        to it. We match the area you type to a service area — a landmark is what turns that area
        into a door.
      </p>

      <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3">
        <AddressMapPicker onSelect={applySelection} />
        {point ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-green-50 px-2.5 py-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-green-800">
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              Exact pin saved: {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
            </p>
            <button
              type="button"
              onClick={() => {
                setPoint(null);
                setPinProblem(null);
              }}
              className="inline-flex items-center gap-1 text-xs font-medium text-green-900 hover:underline"
            >
              <X className="h-3 w-3" aria-hidden="true" />
              Remove pin
            </button>
          </div>
        ) : null}
        {pinProblem ? (
          <p role="status" className="mt-2 text-xs text-amber-700">
            {pinProblem}
          </p>
        ) : null}
      </div>

      <div className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
          <Field id="address-label" label="Name it" error={errors.label}>
            <input
              id="address-label"
              value={fields.label}
              onChange={(e) => set('label')(e.target.value)}
              maxLength={40}
              placeholder="Home"
              className={INPUT}
            />
          </Field>
          <Field id="address-type" label="Kind" error={errors.address_type}>
            <select
              id="address-type"
              value={fields.addressType}
              onChange={(e) => set('addressType')(e.target.value as AddressTypeInput)}
              className={INPUT}
            >
              <option value="home">Home</option>
              <option value="work">Work</option>
              <option value="other">Other</option>
            </select>
          </Field>
        </div>

        <Field id="address-line1" label="Flat / house and street" error={errors.line1} required>
          <input
            id="address-line1"
            value={fields.line1}
            onChange={(e) => set('line1')(e.target.value)}
            maxLength={200}
            placeholder="12, 4th Cross"
            className={INPUT}
          />
        </Field>

        <Field id="address-line2" label="Building, floor" error={errors.line2}>
          <input
            id="address-line2"
            value={fields.line2}
            onChange={(e) => set('line2')(e.target.value)}
            maxLength={200}
            placeholder="Optional"
            className={INPUT}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="address-area" label="Area or locality" error={errors.area} required>
            <input
              id="address-area"
              value={fields.area}
              onChange={(e) => set('area')(e.target.value)}
              maxLength={120}
              placeholder="Indiranagar"
              className={INPUT}
            />
          </Field>
          <Field id="address-city" label="City" error={errors.city} required>
            <input
              id="address-city"
              value={fields.city}
              onChange={(e) => set('city')(e.target.value)}
              maxLength={120}
              placeholder="Bengaluru"
              className={INPUT}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
          <Field id="address-state" label="State" error={errors.state} required>
            <input
              id="address-state"
              value={fields.state}
              onChange={(e) => set('state')(e.target.value)}
              maxLength={120}
              placeholder="Karnataka"
              className={INPUT}
            />
          </Field>
          <Field id="address-pincode" label="Pincode" error={errors.pincode} required>
            <input
              id="address-pincode"
              value={fields.pincode}
              onChange={(e) => set('pincode')(e.target.value)}
              maxLength={6}
              inputMode="numeric"
              placeholder="560038"
              className={INPUT}
            />
          </Field>
        </div>

        <Field id="address-landmark" label="Landmark" error={errors.landmark}>
          <input
            id="address-landmark"
            value={fields.landmark}
            onChange={(e) => set('landmark')(e.target.value)}
            maxLength={160}
            placeholder="Opposite the metro station"
            className={INPUT}
          />
        </Field>

        <Field id="address-access" label="Access notes" error={errors.access_notes}>
          <textarea
            id="address-access"
            value={fields.accessNotes}
            onChange={(e) => set('accessNotes')(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="Gate code, parking, which floor…"
            className={INPUT}
          />
        </Field>
      </div>

      {problem ? (
        <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {problem}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <button
          type="submit"
          disabled={busy}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : (
            'Save address and continue'
          )}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
