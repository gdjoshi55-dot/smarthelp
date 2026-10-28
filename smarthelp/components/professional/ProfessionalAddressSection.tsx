'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import dynamic from 'next/dynamic';
import { MapPin, X } from 'lucide-react';
import { authorizationHeader } from '@/lib/sessionHeaders';
import type { AddressSelection } from '@/lib/googleMapsAddress';

const AddressMapPicker = dynamic(() => import('@/components/map/AddressMapPicker'), {
  ssr: false,
  loading: () => (
    <div className="flex h-56 items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-500">
      Loading the map…
    </div>
  ),
});

interface ProfessionalAddress {
  address_line1: string | null;
  address_line2: string | null;
  address_area: string | null;
  address_city: string | null;
  address_state: string | null;
  address_pincode: string | null;
  address_lat: number | null;
  address_lng: number | null;
  address_updated_at: string | null;
}

export default function ProfessionalAddressSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [address, setAddress] = useState<ProfessionalAddress>({
    address_line1: '',
    address_line2: '',
    address_area: '',
    address_city: '',
    address_state: '',
    address_pincode: '',
    address_lat: null,
    address_lng: null,
    address_updated_at: null,
  });
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const auth = await authorizationHeader();
        const res = await fetch('/api/professionals/me/address', {
          headers: { accept: 'application/json', ...auth },
          credentials: 'include',
        });
        if (!res.ok) throw new Error('Failed to load');
        const json = await res.json();
        const data = json.data?.address ?? {};
        setAddress({
          address_line1: data.address_line1 ?? '',
          address_line2: data.address_line2 ?? '',
          address_area: data.address_area ?? '',
          address_city: data.address_city ?? '',
          address_state: data.address_state ?? '',
          address_pincode: data.address_pincode ?? '',
          address_lat: data.address_lat ?? null,
          address_lng: data.address_lng ?? null,
          address_updated_at: data.address_updated_at ?? null,
        });
        if (data.address_lat != null && data.address_lng != null) {
          setPoint({ lat: Number(data.address_lat), lng: Number(data.address_lng) });
        }
      } catch {
        // non-blocking
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function applySelection(selection: AddressSelection) {
    setPoint({ lat: selection.lat, lng: selection.lng });
    setAddress((current) => ({
      ...current,
      address_line1: selection.line1 || current.address_line1,
      address_line2: selection.line2 || current.address_line2,
      address_area: selection.area || current.address_area,
      address_city: selection.city || current.address_city,
      address_state: selection.state || current.address_state,
      address_pincode: selection.pincode || current.address_pincode,
    }));
  }

  async function save() {
    setSaving(true);
    try {
      const auth = await authorizationHeader();
      const body: any = {
        address_line1: address.address_line1?.trim(),
        address_line2: address.address_line2?.trim() || null,
        address_area: address.address_area?.trim(),
        address_city: address.address_city?.trim(),
        address_state: address.address_state?.trim(),
        address_pincode: address.address_pincode?.trim(),
      };
      if (point) {
        body.address_lat = point.lat;
        body.address_lng = point.lng;
      }
      const res = await fetch('/api/professionals/me/address', {
        method: 'PUT',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...auth },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || 'Failed to save');
      }
      const json = await res.json();
      const data = json.data?.address ?? {};
      if (data.address_lat != null && data.address_lng != null) setPoint({ lat: Number(data.address_lat), lng: Number(data.address_lng) });
      toast.success('Service address saved.');
    } catch (e: any) {
      toast.error(e.message || 'Failed to save address');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-base font-semibold text-gray-900">Service address</h2>
        <p className="mt-1 text-sm text-gray-600">Loading…</p>
      </section>
    );
  }

  return (
    <section className="bg-white border border-gray-200 rounded-xl p-6">
      <h2 className="text-base font-semibold text-gray-900">Service address</h2>
      <p className="mt-1 text-sm text-gray-600">Add your service address or pin it on the map. This helps admins identify your base location.</p>

      <div className="mt-4 rounded-lg border border-gray-200 bg-white p-3">
        <AddressMapPicker onSelect={applySelection} title="Find your service address" hint="Search or drop a pin at your base location. You can edit the fields below." />
        {point ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-green-50 px-2.5 py-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-green-800">
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              Pin saved: {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
            </p>
            <button type="button" onClick={() => setPoint(null)} className="inline-flex items-center gap-1 text-xs font-medium text-green-900 hover:underline">
              <X className="h-3 w-3" aria-hidden="true" />
              Remove pin
            </button>
          </div>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-gray-700">Address line 1</label>
          <input value={address.address_line1 ?? ''} onChange={(e) => setAddress((c) => ({ ...c, address_line1: e.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-gray-700">Address line 2 (optional)</label>
          <input value={address.address_line2 ?? ''} onChange={(e) => setAddress((c) => ({ ...c, address_line2: e.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Area/Locality</label>
          <input value={address.address_area ?? ''} onChange={(e) => setAddress((c) => ({ ...c, address_area: e.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">City</label>
          <input value={address.address_city ?? ''} onChange={(e) => setAddress((c) => ({ ...c, address_city: e.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">State</label>
          <input value={address.address_state ?? ''} onChange={(e) => setAddress((c) => ({ ...c, address_state: e.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Pincode</label>
          <input value={address.address_pincode ?? ''} onChange={(e) => setAddress((c) => ({ ...c, address_pincode: e.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </div>
      </div>

      <div className="mt-4">
        <button onClick={save} disabled={saving} className="inline-flex items-center gap-2 bg-blue-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save service address'}
        </button>
      </div>
    </section>
  );
}
