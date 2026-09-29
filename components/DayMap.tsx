"use client";
import { useCallback, useEffect, useRef } from "react";
import { setOptions, importLibrary } from "@googlemaps/js-api-loader";

export type MapPin = { lat: number; lng: number; label: string };

export default function DayMap({ center, pins }: { center: { lat: number; lng: number }; pins: MapPin[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const centerRef = useRef(center);
  const pinsRef = useRef(pins);

  const renderMarkers = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    map.setCenter(centerRef.current);

    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    const bounds = new google.maps.LatLngBounds();
    pinsRef.current.forEach((p, i) => {
      markersRef.current.push(
        new google.maps.Marker({ position: p, map, label: `${i + 1}`, title: p.label }),
      );
      bounds.extend(p);
    });
    if (pinsRef.current.length > 1) map.fitBounds(bounds, 48);
  }, []);

  // Create the map instance once.
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
    if (!key || !ref.current) return;
    setOptions({ key });
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    Promise.all([importLibrary("maps"), importLibrary("marker")]).then(([{ Map }]) => {
      if (cancelled || !ref.current || mapRef.current) return;
      mapRef.current = new Map(ref.current, { center: centerRef.current, zoom: 13 });
      renderMarkers();
      // The container can settle its size after map creation (fonts/layout);
      // vanilla Maps doesn't redraw on container resize, so nudge it.
      observer = new ResizeObserver(() => {
        const map = mapRef.current;
        if (!map) return;
        google.maps.event.trigger(map, "resize");
        renderMarkers();
      });
      observer.observe(ref.current);
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [renderMarkers]);

  // Update center/markers on stable primitive changes, without rebuilding the map.
  const pinsKey = JSON.stringify(pins);
  useEffect(() => {
    centerRef.current = center;
    pinsRef.current = pins;
    renderMarkers();
  }, [center, pins, center.lat, center.lng, pinsKey, renderMarkers]);

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY) return null;
  return <div ref={ref} className="h-72 w-full overflow-hidden rounded-2xl border border-[#EADFCC] shadow-sm" />;
}
