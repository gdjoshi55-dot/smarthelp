"use client";

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const GoogleMap = dynamic(() => import('./GoogleMap'), { ssr: false });
const OSMMap = dynamic(() => import('./OSMMap'), { ssr: false });

export interface TravelPoint {
  lat: number;
  lng: number;
  label?: string;
}

export interface TravelTimeProps {
  origin?: TravelPoint | null;
  destination?: TravelPoint | null;
  showTravelTime?: boolean;
}

export function TravelTimeMap({ origin, destination, showTravelTime = true }: TravelTimeProps) {
  const [travel, setTravel] = useState<{ durationMinutes: number | null; distanceKm: number | null; durationText: string | null; distanceText: string | null } | null>(null);
  const useGoogle = true;

  useEffect(() => {
    async function fetchTravel() {
      if (!showTravelTime || !origin || !destination) return;
      try {
        const res = await fetch(`/api/travel-time?ox=${origin.lat}&oy=${origin.lng}&dx=${destination.lat}&dy=${destination.lng}`);
        const json = await res.json();
        if (json?.ok && json.data) setTravel(json.data);
      } catch {
        // ignore
      }
    }
    fetchTravel();
  }, [origin?.lat, origin?.lng, destination?.lat, destination?.lng, showTravelTime]);

  const markers: any[] = [];
  if (origin) markers.push({ id: 'origin', lat: origin.lat, lng: origin.lng, title: origin.label || 'Worker' });
  if (destination) markers.push({ id: 'dest', lat: destination.lat, lng: destination.lng, title: destination.label || 'Customer' });
  const center = origin || destination || { lat: 12.9716, lng: 77.5946 };

  return (
    <div className="space-y-2">
      <div className="h-64 w-full overflow-hidden rounded-lg border">
        {useGoogle ? (
          <GoogleMap center={center} zoom={12} markers={markers} />
        ) : (
          <OSMMap center={center} zoom={12} markers={markers} />
        )}
      </div>
      {showTravelTime && travel && (travel.durationMinutes != null || travel.distanceKm != null) ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Travel time: {travel.durationText || (travel.durationMinutes != null ? `${travel.durationMinutes} min` : '—')}</span>
          <span>Distance: {travel.distanceText || (travel.distanceKm != null ? `${travel.distanceKm} km` : '—')}</span>
        </div>
      ) : null}
    </div>
  );
}
