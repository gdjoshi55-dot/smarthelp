'use client';

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LatLng } from '@/lib/googleMapsAddress';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

export interface OSMMarker extends LatLng {
  id: string;
  title?: string;
  draggable?: boolean;
  color?: string;
}

interface OSMMapProps {
  center: LatLng;
  zoom?: number;
  markers?: OSMMarker[];
  className?: string;
  fitMarkers?: boolean;
  onMapClick?: (point: LatLng) => void;
  onMarkerDragEnd?: (id: string, point: LatLng) => void;
}

export default function OSMMap({
  center,
  zoom = 12,
  markers = [],
  className,
  fitMarkers = true,
  onMapClick,
  onMarkerDragEnd,
}: OSMMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerMapRef = useRef(new Map<string, L.Marker>());

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current).setView([center.lat, center.lng], zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      onMapClick?.({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markerMapRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([center.lat, center.lng], zoom);
  }, [center.lat, center.lng, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const current = markerMapRef.current;
    const ids = new Set(markers.map((m) => m.id));
    for (const [id, marker] of current) {
      if (!ids.has(id)) {
        marker.remove();
        current.delete(id);
      }
    }
    for (const m of markers) {
      const existing = current.get(m.id);
      if (existing) {
        existing.setLatLng([m.lat, m.lng]);
        if (m.draggable !== undefined) existing.dragging?.[m.draggable ? 'enable' : 'disable']();
        continue;
      }
      const marker = L.marker([m.lat, m.lng], { draggable: m.draggable ?? false, title: m.title });
      marker.addTo(map);
      marker.on('dragend', (e: L.DragEndEvent) => {
        const ll = (e.target as L.Marker).getLatLng();
        onMarkerDragEnd?.(m.id, { lat: ll.lat, lng: ll.lng });
      });
      current.set(m.id, marker);
    }
  }, [markers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitMarkers || markers.length === 0) return;
    if (markers.length === 1) {
      map.setView([markers[0].lat, markers[0].lng], 15);
      return;
    }
    const group = L.featureGroup(markers.map((m) => L.marker([m.lat, m.lng])));
    map.fitBounds(group.getBounds().pad(0.2));
  }, [markers.map((m) => m.id).join('|'), fitMarkers]);

  return <div ref={containerRef} className={className ?? 'h-64 w-full rounded-lg'} />;
}
