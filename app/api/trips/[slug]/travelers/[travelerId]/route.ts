import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/db";
import { authTraveler } from "@/lib/auth";
import { canRemoveTraveler } from "@/lib/permissions";
import { broadcastTripUpdate } from "@/lib/realtime";

const removeSchema = z.object({ token: z.string().min(1) });

/**
 * Removes a traveller from a trip — the organiser pruning duplicates.
 *
 * Their votes go with them (votes.traveler_id cascades), so tallies are
 * recounted and a block their 👎 had unlocked can re-lock. That is intended:
 * the objection left with the person.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string; travelerId: string }> },
): Promise<NextResponse> {
  const { slug, travelerId } = await params;
  const parsed = removeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const db = serviceClient();
  const auth = await authTraveler(db, slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { trip, me } = auth;

  if (me.is_bot) return NextResponse.json({ error: "Only the organiser can remove a traveller" }, { status: 403 });

  const gate = canRemoveTraveler({
    actorIsOrganizer: me.is_organizer,
    actorId: me.id,
    targetId: travelerId,
  });
  if (!gate.allowed) {
    // Self-removal is a bad request; anyone else lacking the role is forbidden.
    const status = me.id === travelerId ? 400 : 403;
    return NextResponse.json({ error: gate.reason }, { status });
  }

  let outcome: unknown;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error } = await db.rpc("remove_trip_traveler_guarded", {
        p_trip_id: trip.id, p_actor_id: me.id, p_target_id: travelerId,
      });
      // A connection created while the RPC waited for its trip lock requires
      // a fresh transaction to acquire the connection before the trip.
      if (error?.code === "TP009") continue;
      if (!error) outcome = data;
      break;
    }
  } catch { /* Keep database and transport details out of the response. */ }
  if (outcome === "not_found") return NextResponse.json({ error: "Traveller not found" }, { status: 404 });
  if (outcome === "forbidden") return NextResponse.json({ error: "Only the organiser can remove a traveller" }, { status: 403 });
  if (outcome === "self_removal") return NextResponse.json({ error: "You can't remove yourself — the trip needs an organiser" }, { status: 400 });
  if (outcome !== "removed") return NextResponse.json({ error: "Could not remove traveller" }, { status: 500 });

  await broadcastTripUpdate(slug).catch(() => {});
  return NextResponse.json({});
}

const markSchema = z.object({ token: z.string().min(1), isBot: z.boolean() });

/**
 * Flag a traveller as an automated assistant, or unflag one.
 *
 * The join API lets a bot declare itself, which handles the well-behaved case.
 * This handles the rest: an assistant that does not declare, or one that joined
 * before the flag existed. Organiser-only, because it changes what a majority
 * means for everyone.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string; travelerId: string }> },
): Promise<NextResponse> {
  const { slug, travelerId } = await params;
  const parsed = markSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const db = serviceClient();
  const auth = await authTraveler(db, slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { trip, me } = auth;

  if (!me.is_organizer) {
    return NextResponse.json({ error: "Only the organiser can flag a traveller" }, { status: 403 });
  }
  if (me.id === travelerId) {
    return NextResponse.json({ error: "You can't flag yourself as an assistant" }, { status: 400 });
  }

  const { data: target } = await db
    .from("travelers").select("id").eq("id", travelerId).eq("trip_id", trip.id).maybeSingle();
  if (!target) return NextResponse.json({ error: "Traveller not found" }, { status: 404 });

  const { error } = await db
    .from("travelers").update({ is_bot: parsed.data.isBot }).eq("id", travelerId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await broadcastTripUpdate(slug).catch(() => {});
  return NextResponse.json({});
}
