import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { previewTripChange, commitTripChange, voteOnTripChange, decideTripChange } from "@/lib/trip-agent-change-service";
import { actionWorld, envelope, ids, move, now } from "./helpers/trip-agent-action-db";
const deps = { now: () => now, createPlanProposal: vi.fn(), createSuggestionProposal: vi.fn(), settleProposal: vi.fn() };
const commit = { externalGroupId: envelope.externalGroupId, externalParticipantId: envelope.externalParticipantId, actionId: ids.action };
beforeEach(() => {
  vi.stubEnv("TRIP_AGENT_IDENTITY_PEPPER", "test-secret"); vi.clearAllMocks();
  deps.createPlanProposal.mockResolvedValue(ids.proposal); deps.createSuggestionProposal.mockResolvedValue(ids.proposal);
  deps.settleProposal.mockResolvedValue({ status: "applied", reasonCode: "approved", reason: "PRIVATE reason", yes: 1, no: 0, needed: 1 });
});
afterEach(() => vi.unstubAllEnvs());
describe("preview and commit", () => {
  it("allows a pre-action database outage to retry", async () => {
    const w = actionWorld();
    w.fail(table => table === "trip_agent_connections");
    expect(await previewTripChange(w.context, move, deps)).toMatchObject({ ok: false, error: { code: "database_unavailable", retryable: true, message: expect.any(String) } });
    expect(w.rows.trip_agent_actions).toHaveLength(0);
  });

  it.each(["failed", "unknown"])("makes persisted %s replay terminal even with a transient stored code", async status => {
    const w = actionWorld(); await previewTripChange(w.context, move, deps);
    Object.assign(w.rows.trip_agent_actions[0], { status, error_code: "database_unavailable" });
    expect(await commitTripChange(w.context, commit, deps)).toMatchObject({ ok: false, error: { code: "database_unavailable", retryable: false } });
    expect(deps.createPlanProposal).not.toHaveBeenCalled();
  });

  it.each(["claim", "create", "finalize"])("makes uncertain %s writes terminal", async stage => {
    const w = actionWorld(); await previewTripChange(w.context, move, deps);
    if (stage === "claim") w.rpc.mockRejectedValueOnce(new Error("PRIVATE lost claim response"));
    if (stage === "create") deps.createPlanProposal.mockRejectedValueOnce(new Error("PRIVATE lost create response"));
    if (stage === "finalize") w.fail((table, operation) => table === "trip_agent_actions" && operation === "update");
    expect(await commitTripChange(w.context, commit, deps)).toMatchObject({ ok: false, error: { code: "database_unavailable", retryable: false } });
  });

  it.each(["vote", "decide"] as const)("makes uncertain %s preparation terminal", async operation => {
    const w = actionWorld(); w.rows.trip_agent_connections[0].granted_scopes = ["trip.vote"];
    w.rpc.mockRejectedValueOnce(new Error("PRIVATE lost preparation response"));
    const run = operation === "vote" ? voteOnTripChange : decideTripChange;
    const input = { ...envelope, actionId: ids.item, ...(operation === "vote" ? { vote: "up" } : { decision: "approve" }) };
    expect(await run(w.context, input, deps)).toMatchObject({ ok: false, error: { code: "database_unavailable", retryable: false } });
  });
  it("resumes an exact executing vote after bounded drift without casting the vote again", async () => {
    const w = actionWorld(); w.rows.trip_agent_connections[0].granted_scopes = ["trip.vote"];
    w.rpc.mockImplementation(async () => {
      const action = w.rows.trip_agent_actions[0];
      Object.assign(action, {status:"executing",proposal_id:ids.proposal});
      return {data:{action:{...action},proposal:w.rows.plan_proposals[0]},error:null};
    });
    const settlement = {status:"open",reasonCode:"awaiting_vote",yes:1,no:0,needed:2,travelerCount:3};
    deps.settleProposal.mockRejectedValueOnce(new Error("database_unavailable")).mockImplementationOnce(async () => {
      Object.assign(w.rows.trip_agent_actions[0],{status:"awaiting_vote",result:{settlement}});
      return settlement;
    });
    const input = {...envelope,actionId:ids.item,vote:"up"};
    expect(await voteOnTripChange(w.context,input,deps)).toMatchObject({ok:false,error:{code:"database_unavailable"}});
    expect(w.rows.trip_agent_actions[0].status).toBe("executing");
    expect(await voteOnTripChange(w.context,input,deps)).toMatchObject({ok:true,data:{settlement}});
    expect(w.rpc).toHaveBeenCalledOnce();
    expect(deps.settleProposal).toHaveBeenCalledTimes(2);
  });
  it.each(["vote", "decide"] as const)("audits %s separately and replays its exact settlement snapshot", async operation => {
    const w = actionWorld();
    w.rows.trip_agent_connections[0].granted_scopes = ["trip.vote"];
    const tally = { status: "open", reasonCode: "awaiting_vote", reason: "PRIVATE", yes: 1, no: 1, needed: 3, travelerCount: 5 };
    deps.settleProposal.mockImplementation(async () => {
      const settlement = { status: tally.status, reasonCode: tally.reasonCode, yes: tally.yes, no: tally.no, needed: tally.needed, travelerCount: tally.travelerCount };
      Object.assign(w.rows.trip_agent_actions[0], { status: "awaiting_vote", result: { settlement } });
      return tally;
    });
    w.rpc.mockImplementation(async (fn, p) => {
      expect(fn).toBe("prepare_trip_agent_proposal_action");
      const action = w.rows.trip_agent_actions.find(a => a.id === p.p_action_id)!;
      Object.assign(action, { status: "executing", proposal_id: ids.proposal });
      return { data: { action: { ...action }, proposal: w.rows.plan_proposals[0] }, error: null };
    });
    const input = { ...envelope, actionId: ids.item, ...(operation === "vote" ? { vote: "up" } : { decision: "approve" }) };
    const run = operation === "vote" ? voteOnTripChange : decideTripChange;
    const result = await run(w.context, input, deps);
    expect(result).toMatchObject({ ok: true, data: { status: "awaiting_vote", settlement: { status: "open", reasonCode: "awaiting_vote", yes: 1, no: 1, needed: 3, travelerCount: 5 } } });
    expect(deps.settleProposal).toHaveBeenCalledWith(w.context.db, expect.objectContaining({
      actorId: ids.actor, ...(operation === "decide" ? { force: "approve" } : {}),
      gateway: expect.objectContaining({ actionId: ids.action, connectionId: ids.connection, tripId: ids.trip }),
    }));
    deps.settleProposal.mockResolvedValue({ ...tally, yes: 99 });
    expect(await run(w.context, input, deps)).toEqual(result);
    expect(deps.settleProposal).toHaveBeenCalledOnce();
    expect(w.rpc).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|digest|normalized_request|raw-person/);
  });
  it("durably reports a machine already-decided failure without inventing a settlement tally", async () => {
    const w = actionWorld(); w.rows.trip_agent_connections[0].granted_scopes = ["trip.vote"];
    const baseRpc = w.rpc.getMockImplementation()!;
    w.rpc.mockImplementation(async (fn, p) => {
      if (fn !== "prepare_trip_agent_proposal_action") return baseRpc(fn, p);
      const action = w.rows.trip_agent_actions.find(a => a.id === p.p_action_id)!;
      action.status = "executing";
      return { data: { action: { ...action }, proposal: w.rows.plan_proposals[0] }, error: null };
    });
    deps.settleProposal.mockRejectedValueOnce({ code: "TP005", message: "private database prose" });
    const input = { ...envelope, actionId: ids.item, decision: "approve" };
    expect(await decideTripChange(w.context, input, deps)).toEqual({ ok: false, error: { code: "proposal_already_decided", message: expect.any(String), retryable: false } });
    expect(await decideTripChange(w.context, input, deps)).toEqual({ ok: false, error: { code: "proposal_already_decided", message: expect.any(String), retryable: false } });
    expect(w.rows.trip_agent_actions[0]).toMatchObject({ status: "failed", error_code: "proposal_already_decided" });
    expect(deps.settleProposal).toHaveBeenCalledOnce();
  });
  it.each(["TP006", "TP007"])("persists safe preparation failure %s on the separate audit action", async dbCode => {
    const w = actionWorld(); w.rows.trip_agent_connections[0].granted_scopes = ["trip.vote"];
    const baseRpc = w.rpc.getMockImplementation()!;
    w.rpc.mockImplementation(async (fn, p) => fn === "prepare_trip_agent_proposal_action"
      ? { data: null, error: { code: dbCode, message: "PRIVATE" } }
      : baseRpc(fn, p));
    const input = { ...envelope, actionId: ids.item, vote: "up" };
    const code = dbCode === "TP006" ? "authority_changed" : "action_not_found";
    expect(await voteOnTripChange(w.context, input, deps)).toEqual({ ok: false, error: { code, message: expect.any(String), retryable: false } });
    expect(await voteOnTripChange(w.context, input, deps)).toEqual({ ok: false, error: { code, message: expect.any(String), retryable: false } });
    expect(w.rpc.mock.calls.filter(([fn]) => fn === "prepare_trip_agent_proposal_action")).toHaveLength(1);
    expect(deps.settleProposal).not.toHaveBeenCalled();
  });
  it("recovers a lost final settlement response from its durable exact snapshot", async () => {
    const w = actionWorld(); w.rows.trip_agent_connections[0].granted_scopes = ["trip.vote"];
    const settlement = { status: "applied", reasonCode: "approved", yes: 2, no: 0, needed: 2, travelerCount: 3 };
    w.rpc.mockImplementation(async () => {
      const action = w.rows.trip_agent_actions[0]; action.status = "executing";
      return { data: { action: { ...action }, proposal: w.rows.plan_proposals[0] }, error: null };
    });
    deps.settleProposal.mockImplementationOnce(async () => {
      Object.assign(w.rows.trip_agent_actions[0], { status: "succeeded", result: { settlement } });
      throw Error("PRIVATE lost RPC response");
    });
    const input = { ...envelope, actionId: ids.item, vote: "up" };
    const result = await voteOnTripChange(w.context, input, deps);
    expect(result).toMatchObject({ ok: true, data: { status: "succeeded", settlement } });
    expect(await voteOnTripChange(w.context, input, deps)).toEqual(result);
    expect(deps.settleProposal).toHaveBeenCalledOnce();
  });
  it("returns durable preview_expired when the database clock expires between the application check and claim", async () => {
    const w = actionWorld(); await previewTripChange(w.context, move, deps);
    w.rpc.mockImplementationOnce(async () => {
      const action = w.rows.trip_agent_actions[0];
      Object.assign(action, { status: "expired", error_code: "preview_expired", confirmation_expires_at: null, result: { status: "expired" } });
      return { data: [{ action: { ...action }, is_organizer: true, authority_policy: w.rows.trip_agent_connections[0].authority_policy }], error: null };
    });
    const beforeExpiry = { ...deps, now: () => new Date("2026-09-01T10:09:59.999Z") };
    expect(await commitTripChange(w.context, commit, beforeExpiry)).toEqual({ ok: false, error: { code: "preview_expired", message: expect.any(String), retryable: false } });
    expect(await commitTripChange(w.context, commit, beforeExpiry)).toEqual({ ok: false, error: { code: "preview_expired", message: expect.any(String), retryable: false } });
    expect(deps.createPlanProposal).not.toHaveBeenCalled();
    expect(deps.settleProposal).not.toHaveBeenCalled();
  });
  it("passes suggestion safety to the atomic duplicate guard and preserves its bounded failure", async () => {
    const w = actionWorld();
    await previewTripChange(w.context, { ...envelope, kind: "suggest", text: "Museum" }, deps);
    deps.createSuggestionProposal.mockRejectedValueOnce({ code: "TP004", message: "private details" });
    expect(await commitTripChange(w.context, commit, deps)).toEqual({ ok: false, error: { code: "duplicate_suggestion", message: expect.any(String), retryable: false } });
    expect(deps.createSuggestionProposal.mock.calls[0][1]).toHaveProperty("expectedState", { tripId: ids.trip, matchingOpenSuggestions: [] });
    expect(w.rows.trip_agent_actions[0].status).toBe("refused");
  });
  it("safely resumes reservation finalization after a failed result write without unknown or a booking attempt", async () => {
    const w = actionWorld();
    await previewTripChange(w.context, { ...envelope, kind: "reservation_prepare", itemId: ids.item, partySize: 4, requestedAt: now.toISOString() }, deps);
    w.fail((table, operation) => table === "trip_agent_actions" && operation === "update");
    expect(await commitTripChange(w.context, commit, deps)).toEqual({ ok: false, error: { code: "database_unavailable", message: expect.any(String), retryable: false } });
    expect(w.rows.trip_agent_actions[0].status).toBe("executing");
    w.fail(undefined);
    expect(await commitTripChange(w.context, commit, deps)).toMatchObject({ ok: true, data: { status: "awaiting_confirmation" } });
    expect(deps.createPlanProposal).not.toHaveBeenCalled();
    expect(deps.createSuggestionProposal).not.toHaveBeenCalled();
  });
  it("hashes equivalent PostgreSQL timestamp encodings consistently", async () => {
    const w = actionWorld(); w.rows.itinerary_items[0].reservation_at = "2026-09-01T10:00:00+00:00";
    await previewTripChange(w.context, move, deps);
    w.rows.itinerary_items[0].reservation_at = "2026-09-01T10:00:00.000Z";
    expect(await commitTripChange(w.context, commit, deps)).toMatchObject({ ok: true, data: { status: "succeeded" } });
  });
  it.each(["rejected", "cancelled"] as const)("persists bounded %s settlement without reporting applied", async status => {
    const w = actionWorld(); await previewTripChange(w.context, move, deps);
    deps.settleProposal.mockResolvedValue({ status, reasonCode: status === "cancelled" ? "proposal_stale" : "rejected", reason: "private" });
    const result = await commitTripChange(w.context, commit, deps);
    expect(w.rows.trip_agent_actions[0]).toMatchObject({ status, confirmation_expires_at: null });
    expect(result).not.toMatchObject({ data: { status: "succeeded" } });
  });
  it("resumes received previews and concurrent preview workers return the same finalized row", async () => {
    const w = actionWorld();
    const results = await Promise.all([previewTripChange(w.context, move, deps), previewTripChange(w.context, move, deps)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ ok: true, data: { status: "previewed" } });
  });
  it("suggestions ignore unrelated plan changes and refuse a matching open suggestion", async () => {
    const w = actionWorld(); const input = { ...envelope, kind: "suggest" as const, text: "Try   Museum" };
    await previewTripChange(w.context, input, deps); w.rows.itinerary_items[0].day_index = 2;
    expect((await commitTripChange(w.context, commit, deps)).ok).toBe(true);
    const duplicate = actionWorld(); duplicate.rows.plan_proposals.push({ trip_id: ids.trip, kind: "suggest", status: "open", suggestion_text: "try museum" });
    expect(await previewTripChange(duplicate.context, input, deps)).toEqual({ ok: false, error: { code: "duplicate_suggestion", message: expect.any(String), retryable: false } });
  });
  it("accepts a traveler reservation request and resolves the independent organizer privately", async () => {
    const w = actionWorld(); w.rows.travelers[0].is_organizer = false;
    w.rows.travelers.push({ id: "organizer", trip_id: ids.trip, is_organizer: true, is_bot: false, display_name: "Private Organizer" });
    expect((await previewTripChange(w.context, { ...envelope, kind: "reservation_prepare", itemId: ids.item, partySize: 4, requestedAt: now.toISOString() }, deps)).ok).toBe(true);
    expect(await commitTripChange(w.context, commit, deps)).toMatchObject({ ok: true, data: { status: "awaiting_confirmation" } });
  });
  it("passes expected safety state to the canonical locked creation guard", async () => {
    const w = actionWorld(); await previewTripChange(w.context, move, deps); await commitTripChange(w.context, commit, deps);
    expect(deps.createPlanProposal.mock.calls[0][1]).toMatchObject({ expectedState: { item: { candidateId: "venue", dayIndex: 0, locked: false }, destination: [] } });
  });
  it.each([move, { ...envelope, kind: "remove", itemId: ids.item }, { ...envelope, kind: "replace", itemId: ids.item, replacementCandidateId: "replacement" }, { ...envelope, kind: "suggest", text: "Museum" }, { ...envelope, kind: "reservation_prepare", itemId: ids.item, partySize: 4, requestedAt: now.toISOString() }] as const)("previews $kind without canonical writes and expires in ten minutes", async input => {
    const w = actionWorld(); const result = await previewTripChange(w.context, input, deps);
    expect(result).toMatchObject({ ok: true, data: { actionId: ids.action, status: "previewed", expiresAt: "2026-09-01T10:10:00.000Z", impact: expect.any(String) } });
    expect(w.writes.every(write => write.table === "trip_agent_actions")).toBe(true);
    expect(deps.createPlanProposal).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/Private Organizer|booking.test|maps.test|fingerprint|raw-person|PRIVATE/);
  });
  it("returns the durable preview for an exact retry", async () => {
    const w = actionWorld(); const first = await previewTripChange(w.context, move, deps);
    w.rows.itinerary_items[0].day_index = 2;
    expect(await previewTripChange(w.context, move, deps)).toEqual(first);
  });
  it("organizer creates an auditable proposal then force approves and stores redacted canonical references", async () => {
    const w = actionWorld(); await previewTripChange(w.context, move, deps);
    const result = await commitTripChange(w.context, commit, deps);
    expect(result).toMatchObject({ ok: true, data: { status: "succeeded", proposalId: ids.proposal } });
    expect(deps.createPlanProposal).toHaveBeenCalledOnce();
    expect(deps.settleProposal).toHaveBeenCalledWith(w.context.db, expect.objectContaining({ actorId: ids.actor, force: "approve" }));
    expect(w.rows.trip_agent_actions[0]).toMatchObject({ status: "succeeded", proposal_id: ids.proposal, canonical_reference: { kind: "plan_proposal", id: ids.proposal }, announcement_status: "pending" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it.each(["move", "remove", "replace", "suggest"] as const)("traveler %s uses one proposal helper, its atomic yes vote, and normal settlement", async kind => {
    const w = actionWorld(); w.rows.travelers[0].is_organizer = false;
    deps.settleProposal.mockResolvedValue({ status: "open", yes: 1, no: 0, needed: 2 });
    const input = kind === "suggest" ? { ...envelope, kind, text: "Museum" } : kind === "replace" ? { ...envelope, kind, itemId: ids.item, replacementCandidateId: "replacement" } : kind === "remove" ? { ...envelope, kind, itemId: ids.item } : move;
    await previewTripChange(w.context, input, deps);
    expect(await commitTripChange(w.context, commit, deps)).toMatchObject({ ok: true, data: { status: "awaiting_vote" } });
    expect(deps.settleProposal.mock.calls[0][1]).not.toHaveProperty("force");
    expect(kind === "suggest" ? deps.createSuggestionProposal : deps.createPlanProposal).toHaveBeenCalledOnce();
    expect(w.writes.some(write => write.table === "plan_proposal_votes")).toBe(false);
  });
  it.each(["executing", "unknown", "succeeded", "awaiting_vote"])("does not execute again when replay is %s", async status => {
    const w = actionWorld(); await previewTripChange(w.context, move, deps); w.rows.trip_agent_actions[0].status = status;
    expect(await commitTripChange(w.context, commit, deps)).toMatchObject(status === "unknown"
      ? { ok: false, error: { code: "database_unavailable", retryable: false } }
      : { ok: true, data: { status } });
    expect(deps.createPlanProposal).not.toHaveBeenCalled();
  });
  it("simultaneous commits run the canonical operation only once", async () => {
    const w = actionWorld(); await previewTripChange(w.context, move, deps);
    const results = await Promise.all([commitTripChange(w.context, commit, deps), commitTripChange(w.context, commit, deps)]);
    expect(results.every(r => r.ok)).toBe(true); expect(deps.createPlanProposal).toHaveBeenCalledOnce();
  });
  it.each(["expired", "changed", "locked", "occupied", "unmatched", "policy", "actor"])("refuses %s before proposal creation", async failure => {
    const w = actionWorld(); await previewTripChange(w.context, move, deps);
    let overrides = deps; let input = commit;
    if (failure === "expired") overrides = { ...deps, now: () => new Date("2026-09-01T10:10:00Z") };
    if (failure === "changed") w.rows.itinerary_items[0].day_index = 2;
    if (failure === "locked") w.rows.itinerary_items[0].reservation_status = "confirmed";
    if (failure === "occupied") w.rows.itinerary_items.push({ ...w.rows.itinerary_items[0], id: "other", day_index: 1, block: "dinner" });
    if (failure === "unmatched") w.rows.trip_agent_participant_mappings[0].status = "revoked";
    if (failure === "actor") input = { ...commit, externalParticipantId: "other" };
    if (failure === "policy") { w.rows.travelers[0].is_organizer = false; w.rows.trip_agent_connections[0].authority_policy = { travelerCanAddSuggestion: false, travelerCanProposeChange: false }; }
    const result = await commitTripChange(w.context, input, overrides);
    expect(result.ok).toBe(false); expect(deps.createPlanProposal).not.toHaveBeenCalled();
    if (failure === "expired") expect(result).toEqual({ ok: false, error: { code: "preview_expired", message: expect.any(String), retryable: false } });
  });
  it("prepares a reservation with 15-minute confirmation expiry and no reservation attempt", async () => {
    const w = actionWorld(); const input = { ...envelope, kind: "reservation_prepare" as const, itemId: ids.item, partySize: 4, requestedAt: now.toISOString() };
    await previewTripChange(w.context, input, deps);
    expect(await commitTripChange(w.context, commit, deps)).toMatchObject({ ok: true, data: { status: "awaiting_confirmation", expiresAt: "2026-09-01T10:15:00.000Z" } });
    expect(deps.createPlanProposal).not.toHaveBeenCalled(); expect(w.writes.every(write => write.table === "trip_agent_actions")).toBe(true);
  });
  it.each(["name", "url"])("invalidates a reservation preview when private organizer %s changes", async field => {
    const w = actionWorld(); const input = { ...envelope, kind: "reservation_prepare" as const, itemId: ids.item, partySize: 4, requestedAt: now.toISOString() };
    await previewTripChange(w.context, input, deps);
    if (field === "name") w.rows.travelers[0].display_name = "Changed name"; else w.rows.itinerary_items[0].booking_url = "https://changed.test";
    expect(await commitTripChange(w.context, commit, deps)).toEqual({ ok: false, error: { code: "plan_changed", message: expect.any(String), retryable: false } });
  });
  it("falls back to candidate Maps route and refuses only when both routes unsupported", async () => {
    const w = actionWorld(); const input = { ...envelope, kind: "reservation_prepare" as const, itemId: ids.item, partySize: 4, requestedAt: now.toISOString() };
    w.rows.itinerary_items[0].booking_url = "javascript:evil";
    expect((await previewTripChange(w.context, input, deps)).ok).toBe(true);
    w.rows.trip_agent_actions = []; w.rows.venue_candidates[0].maps_url = "http://unsafe.test";
    expect(await previewTripChange(w.context, input, deps)).toEqual({ ok: false, error: { code: "booking_route_unavailable", message: expect.any(String), retryable: false } });
  });
  it("binds the private canonical URL inputs when falling back from a malformed booking URL", async () => {
    const w = actionWorld(); w.rows.itinerary_items[0].booking_url = "https://[broken";
    const input = { ...envelope, kind: "reservation_prepare", itemId: ids.item, partySize: 4, requestedAt: now.toISOString() };
    await previewTripChange(w.context, input, deps);
    const result = await commitTripChange(w.context, commit, deps);
    expect(result).toMatchObject({ ok: true, data: { status: "awaiting_confirmation" } });
    expect(w.rpc.mock.calls.find(([name]) => name === "claim_trip_agent_action")?.[1]).toMatchObject({
      p_expected_state: { privateReservation: { bookingUrl: "https://[broken", mapsUrl: "https://maps.test/venue", route: "https://maps.test/venue" } },
    });
    expect(JSON.stringify(w.rows.trip_agent_actions)).not.toMatch(/\[broken|bookingUrl|mapsUrl|Private Organizer/);
  });
  it("does not return success or execute twice after final persistence fails", async () => {
    const w = actionWorld(); await previewTripChange(w.context, move, deps);
    w.fail((table, operation, payload) => table === "trip_agent_actions" && operation === "update" && payload?.status === "succeeded");
    expect(await commitTripChange(w.context, commit, deps)).toEqual({ ok: false, error: { code: "database_unavailable", message: expect.any(String), retryable: false } });
    expect(["executing", "unknown"]).toContain(w.rows.trip_agent_actions[0].status);
    await commitTripChange(w.context, commit, deps); expect(deps.createPlanProposal).toHaveBeenCalledOnce();
  });
  it("maps core stale and database errors to bounded failures, never success", async () => {
    for (const [dbCode, code] of [["23514", "proposal_stale"], ["XX000", "database_unavailable"]]) {
      const w = actionWorld(); await previewTripChange(w.context, move, deps); deps.settleProposal.mockRejectedValueOnce(Object.assign(Error("SECRET DB credential"), { code: dbCode }));
      expect(await commitTripChange(w.context, commit, deps)).toEqual({ ok: false, error: { code, message: expect.any(String), retryable: false } });
    }
  });
});
