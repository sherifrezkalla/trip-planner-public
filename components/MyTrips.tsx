"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { readDeviceTrips, removeDeviceTrip, type DeviceTrip } from "@/lib/device-trips";
import type { TripSummary } from "@/lib/my-trips";
import { formatTripDateRange } from "@/lib/trip-dates";

function planLabel(trip: TripSummary): string {
  const people = `${trip.travelerCount} ${trip.travelerCount === 1 ? "traveller" : "travellers"}`;
  return trip.itemCount > 0 ? `${people} · Plan ready — ${trip.itemCount} stops` : `${people} · No plan yet`;
}

export default function MyTrips() {
  const [entries, setEntries] = useState<DeviceTrip[] | null>(null);
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntries(readDeviceTrips(window.localStorage)));
    return () => cancelAnimationFrame(frame);
  }, []);

  const load = useCallback(async (current: DeviceTrip[]) => {
    if (current.length === 0) {
      setTrips([]);
      setUnavailable([]);
      return;
    }
    setError("");
    try {
      const res = await fetch("/api/my-trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: current }),
      });
      if (!res.ok) {
        setError("Couldn't load your trips.");
        return;
      }
      const body = (await res.json()) as { trips: TripSummary[]; unavailable: string[] };
      setTrips([...body.trips].sort((a, b) => a.startDate.localeCompare(b.startDate)));
      setUnavailable(body.unavailable);
    } catch {
      setError("Couldn't reach the server.");
    }
  }, []);

  useEffect(() => {
    if (!entries) return;
    const frame = requestAnimationFrame(() => void load(entries));
    return () => cancelAnimationFrame(frame);
  }, [entries, load]);

  function forget(slug: string, isLive: boolean) {
    if (isLive && !confirm("Remove this trip from this device? The trip itself stays for everyone else.")) {
      return;
    }
    removeDeviceTrip(window.localStorage, slug);
    setEntries(readDeviceTrips(window.localStorage));
  }

  // Nothing stored yet — a first-time visitor sees only the create form.
  if (!entries || entries.length === 0) return null;

  return (
    <section className="mx-auto mt-2 mb-10 max-w-md px-6">
      <h2 className="font-display text-2xl font-semibold text-[#2D2A24]">Your trips</h2>
      <p className="mt-1 text-xs uppercase tracking-wide text-[#8A8272]">Saved on this device only</p>

      {error ? (
        <div className="mt-4 rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-4 text-center shadow-sm">
          <p className="text-[#8A8272]">{error}</p>
          <button
            onClick={() => entries && load(entries)}
            className="mt-3 rounded-full border border-[#EADFCC] px-4 py-1.5 text-sm text-[#2D2A24] transition hover:bg-[#F3E0D3]"
          >
            Try again
          </button>
        </div>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {trips.map((trip) => (
            <li
              key={trip.slug}
              className="flex items-center gap-3 rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-4 shadow-sm transition hover:shadow-md"
            >
              <Link href={`/t/${trip.slug}`} className="min-w-0 flex-1">
                <span className="font-display block truncate text-lg text-[#2D2A24]">
                  {trip.title || trip.destinationName}
                </span>
                <span className="mt-0.5 block text-sm text-[#8A8272]">
                  {formatTripDateRange(trip.startDate, trip.endDate)}
                </span>
                <span className="mt-0.5 block text-sm text-[#8A8272]">{planLabel(trip)}</span>
              </Link>
              <button
                onClick={() => forget(trip.slug, true)}
                aria-label={`Remove ${trip.title || trip.destinationName} from this device`}
                className="shrink-0 rounded-full px-2 py-1 text-[#8A8272] transition hover:bg-[#F3E0D3] hover:text-[#2D2A24]"
              >
                ✕
              </button>
            </li>
          ))}

          {unavailable.map((slug) => (
            <li
              key={slug}
              className="flex items-center gap-3 rounded-2xl border border-dashed border-[#EADFCC] bg-[#FAF5EC] p-4"
            >
              <div className="min-w-0 flex-1">
                <span className="font-display block text-lg text-[#8A8272]">No longer available</span>
                <span className="mt-0.5 block text-sm text-[#8A8272]">
                  This trip was deleted, or your access to it has expired.
                </span>
              </div>
              <button
                onClick={() => forget(slug, false)}
                aria-label="Remove this unavailable trip from this device"
                className="shrink-0 rounded-full px-2 py-1 text-[#8A8272] transition hover:bg-[#F3E0D3] hover:text-[#2D2A24]"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
