import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  close: vi.fn(),
}));

import { settleProposal, type ProposalRow } from "@/lib/proposal-actions";
import type { SupabaseClient } from "@supabase/supabase-js";

const proposal: ProposalRow = {
  id: "prop-1",
  trip_id: "trip-1",
  item_id: "item-1",
  proposed_by: "nancy",
  kind: "move",
  from_day_index: 7,
  from_block: "afternoon",
  to_day_index: 9,
  to_block: "morning",
  to_candidate_id: null,
  note: null,
  status: "open",
};

type World = {
  readError?: "item" | "trip" | "destination" | "candidate" | "standing";
  votes: { traveler_id: string; value: number }[];
  travelers: number;
  item: Record<string, unknown> | null;
  destinationTaken: boolean;
  /**
   * What a *separate* read of the roster would have returned. Defaults to the
   * same number, so only the skew test has to care.
   */
  travelersOnSeparateRead?: number;
};

/**
 * Minimal stand-in for the query builder shapes settleProposal reaches for.
 *
 * It reads the item facts first and probes the destination second, both from
 * itinerary_items, so the fake flips its answer after the first call.
 */
function dbFor(world: World): SupabaseClient {
  let itemCalls = 0;
  const base = {
    rpc(fn: string, args: { p_settlement?: { status: string }; p_proposal_id?: string; p_actor_id?: string; p_resolution?: string }) {
      if (fn === "settle_plan_proposal_guarded") {
        const saved = { proposalId: args.p_proposal_id, actorId: args.p_actor_id, resolution: args.p_resolution };
        if (args.p_settlement?.status === "applied") mocks.apply(base, saved);
        else if (args.p_settlement?.status !== "open") mocks.close(base, { ...saved, status: args.p_settlement?.status });
        return Promise.resolve({ data: null, error: null });
      }
      if (fn !== "read_proposal_tally") throw new Error(`unexpected rpc ${fn}`);
      return Promise.resolve({
        data: { votes: world.votes, traveler_count: world.travelers },
        error: null,
      });
    },
    from(table: string) {
      const make = (data: unknown, read?: World["readError"]) => {
        const error = read && world.readError === read ? { message: "private database failure" } : null;
        const q: Record<string, unknown> = {};
        for (const key of ["select", "eq", "neq"]) q[key] = () => q;
        q.maybeSingle = () => Promise.resolve({ data: error ? null : data, error });
        q.single = q.maybeSingle;
        q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: error ? null : data, error }).then(resolve);
        return q;
      };
      if (table === "plan_proposal_votes") return make(world.votes);
      if (table === "travelers") {
        const count = world.travelersOnSeparateRead ?? world.travelers;
        return make(Array.from({ length: count }, (_, i) => ({ id: `t${i}` })));
      }
      if (table === "trips") return make({ start_date: "2026-08-07", end_date: "2026-08-19" }, "trip");
      if (table === "venue_candidates") return make({ id: "replacement" }, "candidate");
      if (table === "itinerary_items") {
        itemCalls += 1;
        if (itemCalls === 1) return make(world.item, "item");
        return make(world.destinationTaken ? [{ id: "other" }] : [], world.readError === "standing" ? "standing" : "destination");
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return base as unknown as SupabaseClient;
}

const plannedItem = {
  status: "planned",
  is_locked: false,
  reservation_status: "none",
  day_index: 7,
  block: "afternoon",
};

function world(overrides: Partial<World> = {}): World {
  return {
    votes: [{ traveler_id: "nancy", value: 1 }],
    travelers: 7,
    item: plannedItem,
    destinationTaken: false,
    ...overrides,
  };
}

describe("settleProposal", () => {
  it("guards legacy open settlements and recomputes after TP008", async () => {
    const state = world();
    const db = dbFor(state);
    const read = db.rpc.bind(db);
    let attempts = 0;
    const rpc = vi.spyOn(db, "rpc").mockImplementation((name, args) => {
      if (name === "read_proposal_tally") return read(name, args);
      attempts++;
      if (attempts === 1) {
        state.travelers = 8;
        return Promise.resolve({ data: null, error: { code: "TP008" } }) as unknown as ReturnType<typeof db.rpc>;
      }
      return Promise.resolve({ data: null, error: null }) as unknown as ReturnType<typeof db.rpc>;
    });
    const suggestion = { ...proposal, kind: "suggest" as const, item_id: null };
    expect(await settleProposal(db, { proposal: suggestion, actorId: "nancy" })).toMatchObject({ status: "open", needed: 5, travelerCount: 8 });
    expect(attempts).toBe(2);
    expect(rpc.mock.calls.filter(([name]) => name === "read_proposal_tally")).toHaveLength(2);
    expect(rpc).toHaveBeenCalledWith("settle_plan_proposal_guarded", expect.objectContaining({ p_settlement: expect.objectContaining({ status: "open", travelerCount: 8 }) }));
  });
  it("bounds three consecutive drifts without calling unguarded finalizers", async () => {
    const db = dbFor(world());
    const read = db.rpc.bind(db);
    const rpc = vi.spyOn(db, "rpc").mockImplementation((name, args) => name === "read_proposal_tally" ? read(name, args) : Promise.resolve({ data: null, error: { code: "TP008" } }) as unknown as ReturnType<typeof db.rpc>);
    await expect(settleProposal(db, { proposal: { ...proposal, kind: "suggest", item_id: null }, actorId: "organizer", force: "approve" })).rejects.toThrow("database_unavailable");
    expect(rpc.mock.calls.filter(([name]) => name === "read_proposal_tally")).toHaveLength(3);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it("lets explicit organizer approval override an earlier suggestion vote against it", async () => {
    const suggestion = { ...proposal, kind: "suggest" as const, item_id: null, suggestion_text: "Museum" };
    const votes = ["a", "b", "c", "d"].map(traveler_id => ({ traveler_id, value: -1 }));
    const result = await settleProposal(dbFor(world({ votes })), { proposal: suggestion, actorId: "organizer", force: "approve" });
    expect(result).toMatchObject({ status: "applied", no: 4, yes: 0, travelerCount: 7 });
    expect(mocks.apply).toHaveBeenCalledOnce(); expect(mocks.close).not.toHaveBeenCalled();
  });
  it("preserves the actual tally when staleness is a missing item", async () => {
    const result = await settleProposal(dbFor(world({ item: null })), { proposal, actorId: "organizer", force: "approve" });
    expect(result).toMatchObject({ status: "cancelled", yes: 1, no: 0, needed: 4, travelerCount: 7 });
  });
  it.each([false, true])("saves the exact gateway verdict under the final authority guard; stale=%s", async stale => {
    const db = dbFor(world({ destinationTaken: stale }));
    const read = db.rpc.bind(db);
    const rpc = vi.spyOn(db, "rpc").mockImplementation((name, args) => name === "read_proposal_tally" ? read(name, args) : Promise.resolve({ data: null, error: null }) as unknown as ReturnType<typeof db.rpc>);
    const gateway = { actionId: "action", connectionId: "connection", tripId: "trip-1", actorDigest: "actor-digest", groupDigest: "group-digest" };
    const result = await settleProposal(db, { proposal, actorId: "organizer", force: "approve", gateway });
    expect(result.status).toBe(stale ? "cancelled" : "applied");
    const { reason, ...settlement } = result;
    expect(rpc).toHaveBeenCalledWith("settle_trip_agent_proposal_action", {
      p_action_id: "action", p_connection_id: "connection", p_trip_id: "trip-1", p_actor_digest: "actor-digest", p_group_digest: "group-digest",
      p_actor_id: "organizer", p_proposal_id: "prop-1", p_force: "approve", p_resolution: reason, p_settlement: settlement,
    });
    expect(mocks.apply).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled();
  });
  it.each(["item", "trip", "destination", "candidate", "standing"] as const)("does not mutate a proposal when the %s safety read fails", async (readError) => {
    const target = ["candidate", "standing"].includes(readError)
      ? { ...proposal, kind: "replace" as const, to_candidate_id: "replacement" }
      : proposal;
    await expect(settleProposal(dbFor(world({ readError })), {
      proposal: target, actorId: "organizer", force: "approve",
    })).rejects.toThrow("database_unavailable");
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 14, 10, 0, 0)); // day index 7
    mocks.apply.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
  });

  it("applies an accepted concierge suggestion without reading an itinerary item", async () => {
    const suggestion: ProposalRow = {
      ...proposal,
      item_id: null,
      kind: "suggest",
      from_day_index: null,
      from_block: null,
      to_day_index: null,
      to_block: null,
      suggestion_text: "Blue Lagoon",
    };
    const votes = ["nancy", "sarah", "maya", "sameh"].map((t) => ({ traveler_id: t, value: 1 }));
    const result = await settleProposal(dbFor(world({ votes })), { proposal: suggestion, actorId: "sameh" });
    expect(result).toMatchObject({ status: "applied", yes: 4, needed: 4 });
    expect(mocks.apply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ proposalId: "prop-1" }));
  });

  it("leaves a proposal open while the group is short of the threshold", async () => {
    const result = await settleProposal(dbFor(world()), { proposal, actorId: "nancy" });

    expect(result).toMatchObject({ status: "open", yes: 1, needed: 4 });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("applies once four of seven agree", async () => {
    const votes = ["nancy", "sarah", "maya", "sameh"].map((t) => ({ traveler_id: t, value: 1 }));
    const result = await settleProposal(dbFor(world({ votes })), { proposal, actorId: "sameh" });

    expect(result.status).toBe("applied");
    expect(result.reason).toBe("Applied by group vote, 4 of 7.");
    // The organiser alert quotes this rather than counting the roster again.
    expect(result.travelerCount).toBe(7);
    expect(mocks.apply).toHaveBeenCalledWith(expect.anything(), {
      proposalId: "prop-1",
      actorId: "sameh",
      resolution: "Applied by group vote, 4 of 7.",
    });
  });

  it("lets the organiser approve without any votes", async () => {
    const result = await settleProposal(dbFor(world()), {
      proposal,
      actorId: "organizer",
      force: "approve",
    });

    expect(result.status).toBe("applied");
    expect(result.reason).toBe("Approved by the organiser.");
    expect(mocks.apply).toHaveBeenCalled();
  });

  it("lets the organiser reject without any votes", async () => {
    const result = await settleProposal(dbFor(world()), {
      proposal,
      actorId: "organizer",
      force: "reject",
    });

    expect(result.status).toBe("rejected");
    expect(mocks.close).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "rejected",
      resolution: "Turned down by the organiser.",
    }));
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("cancels rather than applying when the destination filled, even on approval", async () => {
    const result = await settleProposal(dbFor(world({ destinationTaken: true })), {
      proposal,
      actorId: "organizer",
      force: "approve",
    });

    expect(result.status).toBe("cancelled");
    expect(result.reason).toBe("Cancelled — Day 10 morning was filled.");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("cancels a proposal whose activity the group already did", async () => {
    const votes = ["nancy", "sarah", "maya", "sameh"].map((t) => ({ traveler_id: t, value: 1 }));
    const result = await settleProposal(
      dbFor(world({ votes, item: { ...plannedItem, status: "done" } })),
      { proposal, actorId: "sameh" },
    );

    expect(result.status).toBe("cancelled");
    expect(result.reason).toBe("Cancelled — the group already did it.");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("cancels when the activity has since been booked", async () => {
    const result = await settleProposal(
      dbFor(world({ item: { ...plannedItem, reservation_status: "confirmed" } })),
      { proposal, actorId: "organizer", force: "approve" },
    );

    expect(result.status).toBe("cancelled");
    expect(result.reason).toBe("Cancelled — it now has a booking.");
  });

  it("records a group refusal once four of seven object", async () => {
    const votes = ["nancy", "sarah", "maya", "sameh"].map((t) => ({ traveler_id: t, value: -1 }));
    const result = await settleProposal(dbFor(world({ votes })), { proposal, actorId: "sameh" });

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("Turned down by the group, 4 of 7.");
  });

  /**
   * The numerator and the denominator have to describe the same instant. Read
   * as two statements they do not: each gets its own snapshot, so a traveller
   * joining between them yields a majority that never existed — four of seven
   * applying against a roster that is already eight and needs five.
   */
  it("counts votes against the roster from the same read", async () => {
    const votes = ["nancy", "sarah", "maya", "sameh"].map((t) => ({ traveler_id: t, value: 1 }));
    const result = await settleProposal(
      dbFor(world({ votes, travelers: 8, travelersOnSeparateRead: 7 })),
      { proposal, actorId: "sameh" },
    );

    expect(result).toMatchObject({ status: "open", yes: 4, needed: 5 });
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("cancels when the activity vanished from the plan entirely", async () => {
    const result = await settleProposal(dbFor(world({ item: null })), {
      proposal,
      actorId: "organizer",
      force: "approve",
    });

    expect(result.status).toBe("cancelled");
    expect(mocks.close).toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
