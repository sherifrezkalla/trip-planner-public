/**
 * Deciding what reaches the organizer's phone, and sending it.
 *
 * Every export here is best-effort by contract: callers fire and continue, and
 * a Telegram outage degrades to the behaviour the app had before alerts
 * existed. Nothing in this file may throw into a request path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMessage, telegramConfigured } from "./telegram";
import {
  appliedByVoteMessage,
  cancelledMessage,
  requestOpenedMessage,
  type ProposalSummary,
} from "./telegram-messages";
import type { ProposalKind } from "./proposals";

export type AlertEvent =
  | { kind: "opened"; yes: number; needed: number }
  | { kind: "applied-by-vote"; yes: number; travelerCount: number }
  | { kind: "cancelled"; reason: string };

type LinkRow = { chat_id: number; traveler_id: string };

/**
 * The linked chat for a trip, or null when the organizer never set alerts up.
 *
 * Absence is the normal case, not an error: most trips will never link one.
 */
async function linkedChat(db: SupabaseClient, tripId: string): Promise<LinkRow | null> {
  const { data } = await db
    .from("organizer_telegram_links")
    .select("chat_id, traveler_id")
    .eq("trip_id", tripId)
    .not("chat_id", "is", null)
    .maybeSingle();
  return (data as LinkRow | null) ?? null;
}

/**
 * Everything a message needs about one proposal.
 *
 * Three plain lookups rather than one nested select with foreign-key hints:
 * plan_proposals points at travelers twice, so the embedded form needs a
 * constraint name baked into a string, which breaks silently if the constraint
 * is ever renamed and is miserable to fake in a test. A missing name degrades
 * to a neutral word rather than losing the alert.
 */
export async function proposalSummary(
  db: SupabaseClient,
  proposalId: string,
): Promise<ProposalSummary | null> {
  const { data } = await db
    .from("plan_proposals")
    .select("id, kind, item_id, proposed_by, from_day_index, from_block, to_day_index, to_block, to_candidate_id, suggestion_text, note")
    .eq("id", proposalId)
    .maybeSingle();
  if (!data) return null;

  const [{ data: proposer }, { data: item }] = await Promise.all([
    db.from("travelers").select("display_name").eq("id", data.proposed_by).maybeSingle(),
    data.item_id
      ? db.from("itinerary_items").select("candidate_id").eq("id", data.item_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // Both names in one read. A `replace` names a stand-in that is deliberately
  // not in the plan yet, so it appears on no itinerary row and has to be looked
  // up alongside the stop it would take over from.
  const wantedIds = [item?.candidate_id, data.to_candidate_id]
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const nameById = new Map<string, string>();
  if (wantedIds.length > 0) {
    const { data: venues } = await db
      .from("venue_candidates")
      .select("id, name")
      .in("id", wantedIds);
    for (const venue of (venues ?? []) as { id: string; name: string }[]) {
      if (venue?.name) nameById.set(venue.id, venue.name);
    }
  }

  // A missing name degrades to a neutral word rather than losing the alert.
  const venueName = nameById.get(item?.candidate_id as string) ?? "an activity";

  return {
    proposalId: data.id as string,
    kind: data.kind as ProposalKind,
    venueName,
    replacementName: nameById.get(data.to_candidate_id as string) ?? null,
    suggestionText: (data.suggestion_text as string | null) ?? null,
    proposedByName: (proposer?.display_name as string | undefined) ?? "A traveller",
    note: (data.note as string | null) ?? "",
    fromDayIndex: data.from_day_index as number | null,
    fromBlock: data.from_block as string | null,
    toDayIndex: data.to_day_index as number | null,
    toBlock: data.to_block as string | null,
  };
}

/**
 * Tell the organizer something happened to a proposal.
 *
 * `actorId` is whoever caused the event. When that is the organizer themselves
 * nothing is sent — being notified of your own tap is noise, and noise is how a
 * channel stops being read.
 */
export async function alertOrganizer(
  db: SupabaseClient,
  args: { tripId: string; proposalId: string; actorId: string; event: AlertEvent },
): Promise<void> {
  if (!telegramConfigured()) return;

  const link = await linkedChat(db, args.tripId);
  if (!link) return;
  if (link.traveler_id === args.actorId) return;

  const summary = await proposalSummary(db, args.proposalId);
  if (!summary) return;

  const message =
    args.event.kind === "opened"
      ? requestOpenedMessage(summary, { yes: args.event.yes, needed: args.event.needed })
      : args.event.kind === "applied-by-vote"
        ? appliedByVoteMessage(summary, {
            yes: args.event.yes,
            travelerCount: args.event.travelerCount,
          })
        : cancelledMessage(summary, args.event.reason);

  await sendMessage({
    chatId: link.chat_id,
    text: message.text,
    buttons: message.buttons,
  });
}

/** Fire-and-forget wrapper, so a caller cannot accidentally await a failure. */
export function alertOrganizerInBackground(
  db: SupabaseClient,
  args: { tripId: string; proposalId: string; actorId: string; event: AlertEvent },
): void {
  void alertOrganizer(db, args).catch(() => {});
}
