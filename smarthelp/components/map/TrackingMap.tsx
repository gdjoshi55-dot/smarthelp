'use client';

import { useRef } from 'react';
import { Navigation } from 'lucide-react';
import dynamic from 'next/dynamic';
import { DEFAULT_MAP_CENTER } from '@/lib/googleMaps';
import { directionsUrl, type LatLng } from '@/lib/googleMapsAddress';
import type { RouteInfo } from './RouteMap';

const GoogleMap = dynamic(() => import('./GoogleMap'), { ssr: false });
const RouteMap = dynamic(() => import('./RouteMap'), { ssr: false });

interface TrackingMapProps {
  destination?: LatLng | null;
  pro?: LatLng | null;
  className?: string;
  showDirections?: boolean;
  showRoute?: boolean;
  onRoute?: (info: RouteInfo | null) => void;
}

export default function TrackingMap({
  destination,
  pro,
  className,
  showDirections = false,
  showRoute = true,
  onRoute,
}: TrackingMapProps) {
  const firstPro = useRef<LatLng | null>(null);
  if (pro && !destination && !firstPro.current) {
    firstPro.current = { lat: pro.lat, lng: pro.lng };
  }

  if (pro && destination && showRoute) {
    return (
      <div className={`relative isolate overflow-hidden ${className ?? 'h-64 w-full rounded-lg'}`}>
        <RouteMap
          origin={pro}
          destination={destination}
          className="h-full w-full rounded-lg"
          onRoute={onRoute}
        />
        {showDirections && destination ? (
          <a
            href={directionsUrl(destination)}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-lg bg-white/95 px-3 py-2 text-xs font-semibold text-gray-800 shadow hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
            Directions
          </a>
        ) : null}
      </div>
    );
  }

  const markers: any[] = [];
  if (pro) markers.push({ id: 'pro', lat: pro.lat, lng: pro.lng, title: 'Professional', color: '#2563eb' });
  if (destination) markers.push({ id: 'destination', lat: destination.lat, lng: destination.lng, title: 'Service address', color: '#dc2626' });

  if (markers.length === 0) return null;
  const center: LatLng = destination ?? firstPro.current ?? pro ?? DEFAULT_MAP_CENTER;

  return (
    <div className={`relative isolate overflow-hidden ${className ?? 'h-64 w-full rounded-lg'}`}>
      <GoogleMap center={center} zoom={15} markers={markers} className="h-full w-full rounded-lg" />
      {showDirections && destination ? (
        <a
          href={directionsUrl(destination)}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-lg bg-white/95 px-3 py-2 text-xs font-semibold text-gray-800 shadow hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
          Directions
        </a>
      ) : null}
    </div>
  );
}
