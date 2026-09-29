import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ids = {
  trip: "10000000-0000-4000-8000-000000000001",
  actor: "20000000-0000-4000-8000-000000000001",
  source: "30000000-0000-4000-8000-000000000001",
  replacement: "30000000-0000-4000-8000-000000000002",
  neighbor: "30000000-0000-4000-8000-000000000003",
  sourceItem: "40000000-0000-4000-8000-000000000001",
  neighborItem: "40000000-0000-4000-8000-000000000002",
};

let db: PGlite;

async function applyMigrations(database: PGlite) {
  await database.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;

    -- Supabase owns this schema in hosted projects. PGlite starts as plain
    -- PostgreSQL, so model the platform table before applying app migrations.
    create schema storage;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
  `);
  const directory = resolve(process.cwd(), "supabase/migrations");
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    try {
      await database.exec(readFileSync(resolve(directory, file), "utf8"));
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
    }
  }
}

async function seedReviewedSwap() {
  await db.query(
    `insert into trips (id, slug, destination_name, destination_place_id, lat, lng, start_date, end_date, budget_level)
     values ($1, 'integration-trip', 'Example City', 'example-city', 50.7, 7.1, '2026-08-26', '2026-08-27', 'mid')`,
    [ids.trip],
  );
  await db.query(
    `insert into travelers (id, trip_id, display_name, token, interests, pace, dietary, is_organizer)
     values ($1, $2, 'Organizer', 'integration-token', array['art'], 'balanced', 'none', true)`,
    [ids.actor, ids.trip],
  );
  await db.query(
    `insert into venue_candidates
       (id, trip_id, place_id, name, category, rating, review_count, opening_hours, opening_periods, lat, lng, maps_url, area, distance_km)
     values
       ($1, $4, 'source', 'Old Museum', 'history', 4.2, 100, '[]', '[]', 50.7000, 7.1000, '', 'Old Town', 1),
       ($2, $4, 'replacement', 'Compact Gallery', 'art', 4.8, 250, '[]', '[]', 50.9500, 7.1000, '', 'Arts Quarter', 25),
       ($3, $4, 'neighbor', 'Lunch Cafe', 'restaurant', 4.5, 180, '[]', '[]', 50.7001, 7.1000, '', 'Old Town', 1)`,
    [ids.source, ids.replacement, ids.neighbor, ids.trip],
  );
  await db.query(
    `insert into itinerary_items
       (id, trip_id, day_index, block, candidate_id, why_note, duration_min, position, travel_warning, area)
     values
       ($1, $3, 0, 'morning', $4, 'Old venue note', 180, 0, false, 'Old Town'),
       ($2, $3, 0, 'lunch', $5, 'Lunch note', 90, 1, false, 'Old Town')`,
    [ids.sourceItem, ids.neighborItem, ids.trip, ids.source, ids.neighbor],
  );

  const snapshot = [
    {
      id: ids.sourceItem,
      dayIndex: 0,
      block: "morning",
      status: "planned",
      isLocked: false,
      reservationLocked: false,
      candidateId: ids.source,
    },
    {
      id: ids.neighborItem,
      dayIndex: 0,
      block: "lunch",
      status: "planned",
      isLocked: false,
      reservationLocked: false,
      candidateId: ids.neighbor,
    },
  ];
  const preview = {
    kind: "adjust-today",
    dayIndex: 0,
    reason: "low energy, museums",
    impact: {
      moves: [],
      skips: [],
      swaps: [{
        itemId: ids.sourceItem,
        fromVenueName: "Old Museum",
        toCandidateId: ids.replacement,
        toVenueName: "Compact Gallery",
        fromDayIndex: 0,
        fromBlock: "morning",
        reason: "A shorter verified art stop fits today's request.",
        durationMin: 60,
        area: "Arts Quarter",
      }],
      warningUpdates: [
        { itemId: ids.sourceItem, travelWarning: false },
        { itemId: ids.neighborItem, travelWarning: true },
      ],
    },
    hasChanges: true,
  };
  const recorded = await db.query<{ preview_id: string }>(
    `select record_adjust_today_preview($1::uuid, $2::uuid, 0, $3, $4, $5::jsonb, $6::jsonb) as preview_id`,
    [ids.trip, ids.actor, preview.reason, "fingerprint-1", JSON.stringify(snapshot), JSON.stringify(preview)],
  );
  return recorded.rows[0].preview_id;
}

async function applySwap(previewId: string, toCandidateId = ids.replacement) {
  return db.query<{ revision_id: string }>(
    `select apply_adjust_today(
       $1::uuid, $2::uuid, $3::uuid, $4, '[]'::jsonb, '[]'::jsonb, $5::jsonb, $6
     ) as revision_id`,
    [
      ids.trip,
      ids.actor,
      previewId,
      "fingerprint-1",
      JSON.stringify([{
        item_id: ids.sourceItem,
        to_candidate_id: toCandidateId,
        from_day_index: 0,
        from_block: "morning",
      }]),
      "low energy, museums",
    ],
  );
}

async function recordReviewedMove(vacateDestination: boolean) {
  await seedReviewedSwap();
  await db.query("update itinerary_items set block = 'afternoon' where id = $1", [ids.neighborItem]);
  const snapshot = [
    {
      id: ids.sourceItem,
      dayIndex: 0,
      block: "morning",
      status: "planned",
      isLocked: false,
      reservationLocked: false,
      candidateId: ids.source,
    },
    {
      id: ids.neighborItem,
      dayIndex: 0,
      block: "afternoon",
      status: "planned",
      isLocked: false,
      reservationLocked: false,
      candidateId: ids.neighbor,
    },
  ];
  const moves = [{
    itemId: ids.sourceItem,
    venueName: "Old Museum",
    fromDayIndex: 0,
    fromBlock: "morning",
    toDayIndex: 0,
    toBlock: "afternoon",
  }];
  const skips = vacateDestination ? [{
    itemId: ids.neighborItem,
    venueName: "Lunch Cafe",
    fromDayIndex: 0,
    fromBlock: "afternoon",
    reason: "Set aside to free the reviewed destination.",
  }] : [];
  const preview = {
    kind: "adjust-today",
    dayIndex: 0,
    reason: "move later",
    impact: { moves, skips, swaps: [], warningUpdates: [] },
    hasChanges: true,
  };
  const recorded = await db.query<{ preview_id: string }>(
    `select record_adjust_today_preview($1::uuid, $2::uuid, 0, $3, $4, $5::jsonb, $6::jsonb) as preview_id`,
    [ids.trip, ids.actor, preview.reason, "move-fingerprint", JSON.stringify(snapshot), JSON.stringify(preview)],
  );
  return { previewId: recorded.rows[0].preview_id, moves, skips };
}

async function applyMove(previewId: string, moves: object[], skips: object[]) {
  return db.query<{ revision_id: string }>(
    `select apply_adjust_today(
       $1::uuid, $2::uuid, $3::uuid, 'move-fingerprint', $4::jsonb, $5::jsonb, '[]'::jsonb, 'move later'
     ) as revision_id`,
    [
      ids.trip,
      ids.actor,
      previewId,
      JSON.stringify(moves.map((move) => ({
        item_id: (move as { itemId: string }).itemId,
        from_day_index: (move as { fromDayIndex: number }).fromDayIndex,
        from_block: (move as { fromBlock: string }).fromBlock,
        to_day_index: (move as { toDayIndex: number }).toDayIndex,
        to_block: (move as { toBlock: string }).toBlock,
      }))),
      JSON.stringify(skips.map((skip) => ({
        item_id: (skip as { itemId: string }).itemId,
        from_day_index: (skip as { fromDayIndex: number }).fromDayIndex,
        from_block: (skip as { fromBlock: string }).fromBlock,
      }))),
    ],
  );
}

describe("adjust-today migration integration", () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await applyMigrations(db);
  }, 120_000);

  beforeEach(async () => {
    await db.exec("truncate table trip_events, adjust_today_previews, itinerary_revisions, itinerary_items, venue_candidate_categories, venue_candidates, travelers, trips cascade");
  });

  afterAll(async () => {
    await db.close();
  });

  it("applies a persisted descriptive preview and replaces all venue-derived metadata coherently", async () => {
    const previewId = await seedReviewedSwap();
    const applied = await applySwap(previewId);
    const item = await db.query<{
      candidate_id: string;
      why_note: string;
      duration_min: number;
      area: string;
      travel_warning: boolean;
      adjust_today_revision_id: string | null;
    }>(
      `select candidate_id, why_note, duration_min, area, travel_warning, adjust_today_revision_id
       from itinerary_items where id = $1`,
      [ids.sourceItem],
    );

    expect(applied.rows[0].revision_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.rows[0]).toEqual({
      candidate_id: ids.replacement,
      why_note: "A shorter verified art stop fits today's request.",
      duration_min: 60,
      area: "Arts Quarter",
      travel_warning: false,
      adjust_today_revision_id: applied.rows[0].revision_id,
    });
    const neighbor = await db.query<{ travel_warning: boolean }>(
      "select travel_warning from itinerary_items where id = $1",
      [ids.neighborItem],
    );
    expect(neighbor.rows[0].travel_warning).toBe(true);
  });

  it("rejects a swap payload that differs from the persisted reviewed preview", async () => {
    const previewId = await seedReviewedSwap();

    await expect(applySwap(previewId, ids.neighbor)).rejects.toThrow(/preview changed/i);

    const item = await db.query<{ candidate_id: string }>(
      "select candidate_id from itinerary_items where id = $1",
      [ids.sourceItem],
    );
    expect(item.rows[0].candidate_id).toBe(ids.source);
  });

  it("applies a move into a destination vacated by a skip in the same reviewed plan", async () => {
    const reviewed = await recordReviewedMove(true);

    await applyMove(reviewed.previewId, reviewed.moves, reviewed.skips);

    const items = await db.query<{ id: string; block: string; status: string }>(
      "select id, block, status from itinerary_items order by id",
    );
    expect(items.rows).toEqual([
      { id: ids.sourceItem, block: "afternoon", status: "planned" },
      { id: ids.neighborItem, block: "afternoon", status: "skipped" },
    ]);
  });

  it("rejects a reviewed move into a destination that remains occupied", async () => {
    const reviewed = await recordReviewedMove(false);

    await expect(applyMove(reviewed.previewId, reviewed.moves, reviewed.skips)).rejects.toThrow(/occupied/i);

    const source = await db.query<{ block: string; status: string }>(
      "select block, status from itinerary_items where id = $1",
      [ids.sourceItem],
    );
    expect(source.rows[0]).toEqual({ block: "morning", status: "planned" });
  });
});
