/**
 * How a trip's dates are written for people.
 *
 * Formatting lived twice, byte for byte: once in the shared-link card and once
 * in the device's trip list. They are the two places a trip is seen before it is
 * opened, so a change to one and not the other would have shown the same trip
 * two ways to the same person.
 */

/**
 * "1 – 7 Sep 2026".
 *
 * The year appears once, on the end date, because a range that carries it twice
 * reads as two dates rather than one span. `en-GB` is fixed rather than taken
 * from the reader's locale: the label is baked into link previews that are
 * rendered by whoever receives them, so a locale-dependent format would make the
 * same card read differently for each person in the group.
 */
export function formatTripDateRange(startDate: string, endDate: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const start = new Date(startDate).toLocaleDateString("en-GB", opts);
  const end = new Date(endDate).toLocaleDateString("en-GB", { ...opts, year: "numeric" });
  return `${start} – ${end}`;
}
