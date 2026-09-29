import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { serviceClient } from "@/lib/db";
import { authTraveler, travelerTokenFrom } from "@/lib/auth";
import { canManageSchedule } from "@/lib/permissions";
import { botStartUrl, botUsername, telegramConfigured } from "@/lib/telegram";
import { z } from "zod";

const linkRequestSchema = z.object({ token: z.string().min(1) });

/** An hour is long enough to switch apps and short enough that a leak dies. */
const CODE_TTL_MS = 60 * 60 * 1000;

/**
 * Start linking the organizer's Telegram account to this trip.
 *
 * Returns a t.me link carrying a single-use code. Nothing is linked until the
 * organizer opens it and Telegram delivers /start to the webhook — this route
 * only issues the invitation.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const parsed = linkRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  if (!telegramConfigured() || !botUsername()) {
    return NextResponse.json({ error: "Telegram alerts are not configured" }, { status: 503 });
  }

  const db = serviceClient();
  const auth = await authTraveler(db, slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const gate = canManageSchedule({ actorIsOrganizer: auth.me.is_organizer });
  if (!gate.allowed) {
    return NextResponse.json({ error: "Only the organiser can set up alerts" }, { status: 403 });
  }

  const code = randomBytes(24).toString("base64url");

  // One channel per trip: re-linking replaces the old row, so an organiser who
  // changes phone is not competing with their own stale chat id.
  const { error: clearError } = await db
    .from("organizer_telegram_links")
    .delete()
    .eq("trip_id", auth.trip.id);
  if (clearError) {
    return NextResponse.json({ error: "Could not start linking" }, { status: 500 });
  }

  const { error } = await db.from("organizer_telegram_links").insert({
    trip_id: auth.trip.id,
    traveler_id: auth.me.id,
    link_code: code,
    code_expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  });
  if (error) return NextResponse.json({ error: "Could not start linking" }, { status: 500 });

  return NextResponse.json({ url: botStartUrl(code), botUsername: botUsername() });
}

/** Whether this trip already has alerts running, for the board's button state. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const token = travelerTokenFrom(req);

  const db = serviceClient();
  const auth = await authTraveler(db, slug, token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!auth.me.is_organizer) return NextResponse.json({ linked: false, available: false });

  const { data } = await db
    .from("organizer_telegram_links")
    .select("linked_at")
    .eq("trip_id", auth.trip.id)
    .not("chat_id", "is", null)
    .maybeSingle();

  return NextResponse.json({
    linked: Boolean(data?.linked_at),
    available: telegramConfigured() && Boolean(botUsername()),
  });
}
