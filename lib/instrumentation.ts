import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * One lifecycle event, written by a server route.
 *
 * The roadmap asks for previewed/applied/abandoned and the follow-through
 * (done/skip/change after an accepted revision) before any broader expansion.
 * `trip_events` is the shared, service-role-only store; this is the small,
 * typed writer so routes do not build the row by hand and never invent a free
 * `kind`.
 */
export type TripEventKind =
  | "adjust_today_previewed"
  | "adjust_today_applied"
  | "adjust_today_abandoned"
  | "activity_done_after_adjust"
  | "activity_skipped_after_adjust"
  | "activity_changed_after_adjust";

/**
 * Record an event; failures are swallowed so instrumentation can never take a
 * user action down with it. A missed metric is a reporting gap, not a broken
 * plan.
 */
export async function trackEvent(
  db: Pick<SupabaseClient, "from">,
  args: { tripId: string; actorId: string | null; kind: TripEventKind; detail?: Record<string, unknown> },
): Promise<void> {
  try {
    const { error } = await db.from("trip_events").insert({
      trip_id: args.tripId,
      actor_id: args.actorId,
      kind: args.kind,
      detail: args.detail ?? {},
    });
    if (error) {
      // Best-effort; surfaced only to server logs.
      console.warn(`trip event ${args.kind} not recorded: ${error.message}`);
    }
  } catch {
    /* instrumentation must never throw into a request path */
  }
}

/**
 * Consume the one-shot revision marker left on an item by adjust-today.
 *
 * Manual moves go through the shared reshuffle RPC, so they cannot clear the
 * marker as part of that write. This conditional clear makes attribution
 * best-effort and single-use: only the request that actually consumes the
 * marker receives the revision id to attach to its event.
 */
export async function takeAdjustAttribution(
  db: Pick<SupabaseClient, "from">,
  args: { tripId: string; itemId: string },
): Promise<string | null> {
  try {
    const { data: item, error: readError } = await db
      .from("itinerary_items")
      .select("adjust_today_revision_id")
      .eq("id", args.itemId)
      .eq("trip_id", args.tripId)
      .maybeSingle();
    const revisionId = item?.adjust_today_revision_id;
    if (readError || typeof revisionId !== "string") return null;

    const { data: cleared, error: clearError } = await db
      .from("itinerary_items")
      .update({ adjust_today_revision_id: null })
      .eq("id", args.itemId)
      .eq("trip_id", args.tripId)
      .eq("adjust_today_revision_id", revisionId)
      .select("id")
      .maybeSingle();
    if (clearError || !cleared) return null;
    return revisionId;
  } catch {
    return null;
  }
}
