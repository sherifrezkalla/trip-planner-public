import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/db";
import { summarizeTrips } from "@/lib/my-trips";
import { myTripsSchema } from "@/lib/schema";

/**
 * Resolves the trip tokens a browser holds into a list it can display.
 *
 * POST rather than GET so traveler tokens travel in the body instead of a URL
 * that would be recorded in server and proxy logs.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const parsed = myTripsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    return NextResponse.json(await summarizeTrips(serviceClient(), parsed.data.entries));
  } catch {
    return NextResponse.json(
      { error: "Couldn't load your trips right now — please try again in a moment." },
      { status: 503 },
    );
  }
}
