export const BOOKING_PROVIDERS = ["thefork", "opentable", "resy", "sevenrooms", "direct"] as const;
export type BookingProvider = (typeof BOOKING_PROVIDERS)[number];
export type AttemptState = "awaiting_approval" | "in_progress" | "needs_choice" | "handoff" | "confirmed" | "failed";

export type ReservationAttemptSummary = {
  state: AttemptState;
  confirmationReference: string | null;
};

export type ReservationAttempt = ReservationAttemptSummary & {
  id: string;
  partySize: number;
  requestedAt: string;
  bookingName?: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  alternatives: string[];
  routes: string[];
  routeIndex: number;
  routeProvider: BookingProvider | null;
  confirmationUrl: string | null;
  handoff: string | null;
  approvedAt: string | null;
  attemptedAt: string | null;
  confirmedAt: string | null;
};

export type ReservationAttemptRow = Record<string, unknown>;

/** Only organizers receive booking identity, contact, route, and handoff data. */
export function reservationAttemptForViewer(
  row: ReservationAttemptRow,
  isOrganizer: boolean,
): ReservationAttempt | ReservationAttemptSummary | null {
  if (row.state === "failed") return null;

  const summary: ReservationAttemptSummary = {
    state: row.state as AttemptState,
    confirmationReference: (row.confirmation_reference as string | null) ?? null,
  };
  if (!isOrganizer) return summary;

  return {
    ...summary,
    id: String(row.id),
    partySize: row.party_size as number,
    requestedAt: row.requested_at as string,
    bookingName: row.booking_name as string,
    contactEmail: (row.contact_email as string | null) ?? null,
    contactPhone: (row.contact_phone as string | null) ?? null,
    alternatives: row.alternatives as string[],
    routes: row.routes as string[],
    routeIndex: row.route_index as number,
    routeProvider: (row.route_provider as BookingProvider | null) ?? null,
    confirmationUrl: (row.confirmation_url as string | null) ?? null,
    handoff: (row.handoff as string | null) ?? null,
    approvedAt: (row.approved_at as string | null) ?? null,
    attemptedAt: (row.attempted_at as string | null) ?? null,
    confirmedAt: (row.confirmed_at as string | null) ?? null,
  };
}

export function isOrganizerReservationAttempt(
  attempt: ReservationAttempt | ReservationAttemptSummary | null,
): attempt is ReservationAttempt {
  return attempt !== null && "requestedAt" in attempt;
}

export function bookingProvider(url: string): BookingProvider | null {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (host === "thefork.com" || host.endsWith(".thefork.com")) return "thefork";
  if (host === "opentable.com" || host.endsWith(".opentable.com")) return "opentable";
  if (host === "resy.com" || host.endsWith(".resy.com")) return "resy";
  if (host === "sevenrooms.com" || host.endsWith(".sevenrooms.com")) return "sevenrooms";
  return url.startsWith("https://") ? "direct" : null;
}

export function preciseHandoff(route: string | null, venueName: string, requestedAt: string, partySize: number): string {
  const when = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(requestedAt));
  return route
    ? `Open the booking route for ${venueName} and request ${when} for ${partySize}. Return here with the confirmation reference; the trip will not show confirmed until it is verified.`
    : `Contact ${venueName} directly and request ${when} for ${partySize}. Ask for a confirmation reference, then return here to record it.`;
}
