import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/db";
import { authTraveler, dayCount } from "@/lib/auth";
import { canManageSchedule } from "@/lib/permissions";
import { getCallers } from "@/lib/llm";
import { classifyExposure, EXPOSURE_BATCH_SIZE, type VenueToClassify } from "@/lib/venue-exposure";
import { dailyForecastUrl, isBeyondConfidentForecast, parseDailyForecast } from "@/lib/weather";
import { planWeatherSwaps, type ScannableCandidate, type ScannableItem } from "@/lib/weather-scan";
import { createPlanProposal } from "@/lib/persistence";
import { dateForDayIndex } from "@/lib/attendance";
import { broadcastTripUpdate } from "@/lib/realtime";

export const maxDuration = 300;

/**
 * Classifying every candidate can outlast a request, so a scan does a bounded
 * amount and says what is left. Running it again picks up where it stopped —
 * exposure is stored, so nothing is repeated.
 */
const MAX_BATCHES_PER_SCAN = 8;

const scanSchema = z.object({
  slug: z.string().min(1),
  token: z.string().min(1),
  /** Preview by default. Proposals are only raised when asked for. */
  raiseProposals: z.boolean().optional().default(false),
});

/**
 * Look at the forecast for the days ahead and propose moving threatened
 * activities indoors.
 *
 * The model is asked one thing only — whether a venue is under a roof — and
 * only about venues nobody has classified yet. Matching the forecast, choosing
 * replacements and raising proposals are all deterministic. See
 * `docs/architecture/weather-adaptation.md` for why the split matters.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const parsed = scanSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const db = serviceClient();
  const auth = await authTraveler(db, parsed.data.slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (slug !== parsed.data.slug) return NextResponse.json({ error: "Trip mismatch" }, { status: 400 });

  const gate = canManageSchedule({ actorIsOrganizer: auth.me.is_organizer });
  if (!gate.allowed) return NextResponse.json({ error: gate.reason }, { status: 403 });

  const { trip } = auth;
  const [
    { data: itemRows, error: itemsError },
    { data: candidateRows, error: candidatesError },
  ] = await Promise.all([
    db.from("itinerary_items")
      .select("id, day_index, block, area, candidate_id, status, is_locked, reservation_status")
      .eq("trip_id", trip.id).eq("status", "planned"),
    db.from("venue_candidates")
      .select("id, name, area, category, rating, review_count, lat, lng, exposure").eq("trip_id", trip.id),
  ]);

  // A failed read is not a plan with nothing worth moving. Both errors were
  // dropped, so an unreachable database produced `{ swaps: [], unclassified: 0 }`
  // with a 200 — indistinguishable from a scan that ran and found the forecast
  // kind. The organiser would read that as "nothing to do" on the one day it
  // mattered most.
  const readError = itemsError ?? candidatesError;
  if (readError) {
    return NextResponse.json(
      { error: `Could not read the plan to scan it: ${readError.message}` },
      { status: 500 },
    );
  }

  const items = itemRows ?? [];
  const candidates = candidateRows ?? [];
  if (items.length === 0) return NextResponse.json({ swaps: [], unclassified: 0 });

  // Only the areas the plan actually visits are worth classifying or forecasting.
  const plannedAreas = new Set(items.map((row) => row.area as string));

  const unclassified: VenueToClassify[] = candidates
    .filter((row) => !row.exposure && plannedAreas.has(row.area as string))
    .map((row) => ({ id: row.id as string, name: row.name as string, category: row.category as string }));

  const classifiable = unclassified.slice(0, MAX_BATCHES_PER_SCAN * EXPOSURE_BATCH_SIZE);
  const exposureById = new Map<string, string>();
  if (classifiable.length > 0) {
    const classified = await classifyExposure(getCallers(), classifiable);
    // Grouped by answer, so 200 venues cost three statements rather than 200
    // round trips. Measured: the sequential version put a first scan at 96s.
    const byExposure = new Map<string, string[]>();
    for (const [id, exposure] of classified) {
      exposureById.set(id, exposure);
      byExposure.set(exposure, [...(byExposure.get(exposure) ?? []), id]);
    }
    // If a write fails the classification is not cached, so the next scan pays
    // for it again. Worth saying so rather than reporting the venues as done:
    // `unclassified` is what tells the organiser whether running it again is
    // still needed, and a silent failure makes that number a guess.
    const writes = await Promise.all([...byExposure].map(([exposure, ids]) =>
      db.from("venue_candidates").update({ exposure }).eq("trip_id", trip.id).in("id", ids)));
    const writeError = writes.find((write) => write.error)?.error;
    if (writeError) {
      return NextResponse.json(
        { error: `Could not save venue exposure: ${writeError.message}` },
        { status: 500 },
      );
    }
  }

  const withExposure = (row: (typeof candidates)[number]) =>
    (exposureById.get(row.id as string) ?? row.exposure) as ScannableCandidate["exposure"];

  // One forecast per area, taken at the mean of its venues rather than the
  // trip's base: Monaco's weather is not the destination's.
  const outlookByArea = new Map<string, Awaited<ReturnType<typeof parseDailyForecast>>>();
  const lastDay = dayCount(trip.start_date, trip.end_date) - 1;
  await Promise.all([...plannedAreas].map(async (area) => {
    const inArea = candidates.filter((row) => row.area === area && Number.isFinite(row.lat));
    if (inArea.length === 0) return;
    const lat = inArea.reduce((sum, row) => sum + (row.lat as number), 0) / inArea.length;
    const lng = inArea.reduce((sum, row) => sum + (row.lng as number), 0) / inArea.length;
    try {
      const response = await fetch(
        dailyForecastUrl(lat, lng, trip.start_date, dateForDayIndex(trip.start_date, lastDay)),
        { signal: AbortSignal.timeout(8_000) },
      );
      if (response.ok) outlookByArea.set(area, parseDailyForecast(await response.json()));
    } catch {
      // An area without a forecast is simply not scanned.
    }
  }));

  const scannableItems: ScannableItem[] = items.map((row) => {
    const candidate = candidates.find((c) => c.id === row.candidate_id);
    return {
      id: row.id as string,
      dayIndex: row.day_index as number,
      block: row.block as string,
      area: row.area as string,
      candidateId: row.candidate_id as string,
      candidateName: (candidate?.name as string) ?? "this activity",
      category: (candidate?.category as string) ?? "",
      exposure: candidate ? withExposure(candidate) : null,
      isLocked: row.is_locked as boolean,
      reservationStatus: row.reservation_status as string,
      status: row.status as string,
    };
  });

  const scannableCandidates: ScannableCandidate[] = candidates.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    area: row.area as string,
    category: row.category as string,
    rating: (row.rating as number) ?? null,
    reviewCount: (row.review_count as number) ?? null,
    exposure: withExposure(row),
  }));

  // Each area forecasts its own days, so the outlook is looked up per item.
  const swaps = [...plannedAreas].flatMap((area) => {
    const outlooks = outlookByArea.get(area) ?? [];
    const byDayIndex = new Map(
      outlooks.map((outlook) => [
        Math.round(
          (Date.parse(`${outlook.date}T00:00:00Z`) - Date.parse(`${trip.start_date}T00:00:00Z`))
          / 86_400_000,
        ),
        outlook,
      ]),
    );
    return planWeatherSwaps({
      items: scannableItems.filter((item) => item.area === area),
      candidates: scannableCandidates,
      outlookByDayIndex: byDayIndex,
      alreadyPlanned: scannableItems.map((item) => item.candidateId),
    });
  });

  const raised: string[] = [];
  if (parsed.data.raiseProposals) {
    for (const swap of swaps) {
      try {
        raised.push(await createPlanProposal(db, {
          tripId: trip.id,
          itemId: swap.item.id,
          proposedBy: auth.me.id,
          kind: "replace",
          toDayIndex: null,
          toBlock: null,
          toCandidateId: swap.replacement.id,
          note: swap.reason.slice(0, 200),
        }));
      } catch {
        // A slot that cannot take a proposal right now — one is already open, or
        // it just got booked — should not stop the rest of the scan.
      }
    }
    if (raised.length > 0) await broadcastTripUpdate(slug).catch(() => {});
  }

  return NextResponse.json({
    swaps: swaps.map((swap) => ({
      itemId: swap.item.id,
      dayIndex: swap.item.dayIndex,
      block: swap.item.block,
      replacing: swap.item.candidateName,
      with: swap.replacement.name,
      reason: swap.reason,
      /** Past this many days the forecast is indicative; re-run nearer the day. */
      beyondConfidentForecast: isBeyondConfidentForecast(swap.outlook.date),
    })),
    proposalsRaised: raised.length,
    unclassified: unclassified.length - classifiable.length,
  });
}
