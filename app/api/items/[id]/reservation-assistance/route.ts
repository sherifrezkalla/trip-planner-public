import { NextResponse } from "next/server";
import { authTraveler } from "@/lib/auth";
import { serviceClient } from "@/lib/db";
import {
  bookingProvider,
  preciseHandoff,
  reservationAttemptForViewer,
  type ReservationAttemptRow,
} from "@/lib/reservation-assistance";
import { confirmReservationAttempt } from "@/lib/persistence";
import { broadcastTripUpdate } from "@/lib/realtime";
import { createReservationAttemptSchema, updateReservationAttemptSchema } from "@/lib/schema";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const parsed = createReservationAttemptSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const db = serviceClient();
  const auth = await authTraveler(db, parsed.data.slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!auth.me.is_organizer) return NextResponse.json({ error: "Only the organizer can request a reservation" }, { status: 403 });
  const { data: item, error: itemError } = await db.from("itinerary_items")
    .select("id").eq("id", id).eq("trip_id", auth.trip.id).maybeSingle();
  if (itemError) return NextResponse.json({ error: "Could not verify the reservation activity" }, { status: 500 });
  if (!item) return NextResponse.json({ error: "Reservation activity not found" }, { status: 404 });
  const routeProvider = bookingProvider(parsed.data.routes[0]);
  if (!routeProvider) return NextResponse.json({ error: "No supported booking route" }, { status: 400 });
  const { data, error } = await db.from("reservation_attempts").insert({
    trip_id: auth.trip.id, itinerary_item_id: id, created_by: auth.me.id,
    party_size: parsed.data.partySize, requested_at: parsed.data.requestedAt,
    booking_name: parsed.data.bookingName, contact_email: parsed.data.contactEmail,
    contact_phone: parsed.data.contactPhone, alternatives: parsed.data.alternatives,
    routes: parsed.data.routes, route_provider: routeProvider,
  }).select("*").single();
  if (error) {
    const duplicate = error.code === "23505";
    const missingItem = error.code === "23503";
    return NextResponse.json(
      { error: duplicate ? "A reservation attempt is already active for this activity" : missingItem ? "Reservation activity not found" : "Could not prepare the reservation" },
      { status: duplicate ? 409 : missingItem ? 404 : 500 },
    );
  }
  await broadcastTripUpdate(parsed.data.slug).catch(() => {});
  return NextResponse.json({ attempt: reservationAttemptForViewer(data, true) }, { status: 201 });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const parsed = updateReservationAttemptSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const db = serviceClient();
  const auth = await authTraveler(db, parsed.data.slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!auth.me.is_organizer) return NextResponse.json({ error: "Only the organizer can authorize a reservation" }, { status: 403 });
  const { data: current, error: readError } = await db.from("reservation_attempts").select("*, itinerary_items(venue_candidates(name))")
    .eq("id", id).eq("trip_id", auth.trip.id).single();
  if (readError || !current) return NextResponse.json({ error: "Reservation attempt not found" }, { status: 404 });
  const now = new Date().toISOString();
  const routes = current.routes as string[];
  const alternatives = current.alternatives as string[];
  if (parsed.data.action === "confirm") {
    if (!["in_progress", "handoff"].includes(current.state) || !parsed.data.confirmationReference) return conflict();
    try {
      const confirmed = await confirmReservationAttempt(db, {
        tripId: auth.trip.id,
        actorId: auth.me.id,
        attemptId: id,
        confirmationReference: parsed.data.confirmationReference,
        confirmationUrl: parsed.data.confirmationUrl ?? null,
      });
      await broadcastTripUpdate(parsed.data.slug).catch(() => {});
      return NextResponse.json({ attempt: reservationAttemptForViewer(confirmed, true), route: null });
    } catch (error) {
      return confirmationError(error);
    }
  }

  let changes: Record<string, unknown>;
  if (parsed.data.action === "approve") {
    if (current.state !== "awaiting_approval") return conflict();
    changes = { state: "in_progress", approved_at: now, attempted_at: now };
  } else if (parsed.data.action === "route_failed") {
    if (current.state !== "in_progress") return conflict();
    const next = current.route_index + 1;
    changes = next < routes.length
      ? { state: "in_progress", route_index: next, route_provider: bookingProvider(routes[next]), attempted_at: now }
      : alternatives.length > 0
        ? { state: "needs_choice" }
        : { state: "handoff", handoff: preciseHandoff(routes.at(-1) ?? null, venueName(current), current.requested_at, current.party_size) };
  } else if (parsed.data.action === "choose_alternative") {
    if (current.state !== "needs_choice" || !parsed.data.alternativeAt || !alternatives.includes(parsed.data.alternativeAt)) return conflict();
    changes = { state: "in_progress", requested_at: parsed.data.alternativeAt, route_index: 0, route_provider: bookingProvider(routes[0]), attempted_at: now };
  } else {
    if (!["awaiting_approval", "in_progress", "needs_choice", "handoff"].includes(current.state)) return conflict();
    changes = { state: "failed", handoff: preciseHandoff(routes[current.route_index] ?? null, venueName(current), current.requested_at, current.party_size) };
  }
  const { data, error } = await db.from("reservation_attempts").update({ ...changes, updated_at: now })
    .eq("id", id).eq("trip_id", auth.trip.id).eq("state", current.state)
    .eq("route_index", current.route_index).select("*").single();
  if (error || !data) return NextResponse.json({ error: "This reservation attempt changed; reload before trying again" }, { status: 409 });
  await broadcastTripUpdate(parsed.data.slug).catch(() => {});
  return NextResponse.json({ attempt: reservationAttemptForViewer(data, true), route: data.state === "in_progress" ? routes[data.route_index] : null });
}

function conflict() { return NextResponse.json({ error: "That action is not valid for the current reservation state" }, { status: 409 }); }
function confirmationError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "Could not confirm the reservation";
  const status = /not found/i.test(message) ? 404
    : /organizer/i.test(message) ? 403
      : /current state/i.test(message) ? 409
        : /requires|must use/i.test(message) ? 400
          : 500;
  return NextResponse.json({ error: message }, { status });
}
type AttemptRow = ReservationAttemptRow & { itinerary_items?: { venue_candidates?: { name?: string } | null } | null };
function venueName(row: AttemptRow): string { return row.itinerary_items?.venue_candidates?.name ?? "the venue"; }
