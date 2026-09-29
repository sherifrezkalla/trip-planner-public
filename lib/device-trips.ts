export type DeviceTrip = { slug: string; token: string };

/** Joining writes localStorage["tp:{slug}"] = token; this is the other half of that. */
const KEY_PREFIX = "tp:";

/** A family device will hold a handful of trips; the cap only bounds a pathological one. */
export const DEVICE_TRIP_LIMIT = 50;

type ReadableStorage = Pick<Storage, "length" | "key" | "getItem">;
type RemovableStorage = Pick<Storage, "removeItem">;

/** Every trip this browser holds a traveler token for, in storage order. */
export function readDeviceTrips(storage: ReadableStorage): DeviceTrip[] {
  const trips: DeviceTrip[] = [];
  for (let i = 0; i < storage.length && trips.length < DEVICE_TRIP_LIMIT; i++) {
    const key = storage.key(i);
    if (!key || !key.startsWith(KEY_PREFIX)) continue;
    const slug = key.slice(KEY_PREFIX.length);
    const token = storage.getItem(key);
    if (!slug || !token) continue;
    trips.push({ slug, token });
  }
  return trips;
}

/** Forgets a trip on this device only — the trip and its travelers are untouched. */
export function removeDeviceTrip(storage: RemovableStorage, slug: string): void {
  storage.removeItem(`${KEY_PREFIX}${slug}`);
}
