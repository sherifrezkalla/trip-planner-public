/**
 * Distance on the globe.
 *
 * One implementation, because there were two: generation used it to keep a day
 * from spreading across a region, Today Mode to estimate a transfer between two
 * stops. Identical arithmetic, different variable names, no way to tell from
 * either that the other existed — so a correction to one would have silently
 * left the other wrong.
 */

/**
 * Great-circle distance in kilometres.
 *
 * The earth is not a sphere and this pretends it is. That is the right trade
 * here: both callers compare the result against thresholds measured in whole
 * kilometres — "is this day too spread out", "is this a walk or a drive" — and
 * the spherical error over those distances is far below the precision either
 * decision needs.
 */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const radiusKm = 6371;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.sqrt(h));
}
