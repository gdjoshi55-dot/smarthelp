'use client';

import dynamic from 'next/dynamic';
import { USE_GOOGLE_MAPS } from '@/lib/mapConfig';

const loading = () => (
  <div className="flex h-56 items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-500">
    Loading the map…
  </div>
);

const GooglePicker = dynamic(() => import('./AddressMapPickerGoogle'), { ssr: false, loading });
const OSMPicker = dynamic(() => import('./AddressMapPickerOSM'), { ssr: false, loading });

export default function AddressMapPicker(props: any) {
  return USE_GOOGLE_MAPS ? <GooglePicker {...props} /> : <OSMPicker {...props} />;
}
