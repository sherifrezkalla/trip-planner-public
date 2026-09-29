import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { beginAction, stableJson, hashNormalizedJson, writeAction } from "@/lib/trip-agent-actions";
import { digestExternalIdentity } from "@/lib/trip-agent-auth";
import { actionWorld, envelope, ids, move } from "./helpers/trip-agent-action-db";

beforeEach(() => vi.stubEnv("TRIP_AGENT_IDENTITY_PEPPER", "test-secret"));
afterEach(() => vi.unstubAllEnvs());
describe("durable action idempotency", () => {
  it("writes action state through the connection-first transactional boundary", async () => {
    const w = actionWorld();
    const begun = await beginAction(w.context, {
      operation: "preview_change",
      input: move,
      travelerId: ids.actor,
      authorityDecision: "allowed",
    });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    const saved = await writeAction(w.context, begun.data.action, "received", {
      status: "failed",
      error_code: "plan_changed",
      updated_at: "2026-09-01T10:01:00.000Z",
    });

    expect(saved).toMatchObject({ status: "failed", error_code: "plan_changed" });
    expect(w.rpc).toHaveBeenCalledWith("write_trip_agent_action_state", {
      p_connection_id: ids.connection,
      p_trip_id: ids.trip,
      p_lifecycle_generation: 1,
      p_action_id: ids.action,
      p_actor_digest: digestExternalIdentity(ids.connection, 1, envelope.externalParticipantId),
      p_from_status: "received",
      p_patch: {
        status: "failed",
        error_code: "plan_changed",
        updated_at: "2026-09-01T10:01:00.000Z",
      },
    });
    expect(w.writes.filter(({ table, operation }) =>
      table === "trip_agent_actions" && operation === "update")).toHaveLength(1);
  });

  it.each(["vote", "decide"] as const)("stores strict %s commands with independent idempotency", async operation => {
    const w = actionWorld();
    const input = { ...envelope, actionId: ids.action, ...(operation === "vote" ? { vote: "up" } : { decision: "approve" }) };
    const args = { operation, input, travelerId: ids.actor, authorityDecision: "allowed" as const };
    expect(await beginAction(w.context, args)).toMatchObject({ ok: true, data: { replayed: false } });
    expect(w.rows.trip_agent_actions[0].normalized_request).toEqual({ actionId: ids.action, ...(operation === "vote" ? { vote: "up" } : { decision: "approve" }) });
    expect(await beginAction(w.context, args)).toMatchObject({ ok: true, data: { replayed: true } });
    expect(await beginAction(w.context, { ...args, input: { ...input, proposalId: ids.proposal } })).toEqual({ ok: false, error: { code: "invalid_input", message: expect.any(String), retryable: false } });
    expect(await beginAction(w.context, { ...args, input: { ...input, ...(operation === "vote" ? { vote: "down" } : { decision: "reject" }) } })).toEqual({ ok: false, error: { code: "idempotency_conflict", message: expect.any(String), retryable: false } });
  });
  it("canonicalizes nested object order but preserves array order and values", () => {
    expect(stableJson({ z: [{ b: 1, a: 2 }], a: null })).toBe('{"a":null,"z":[{"a":2,"b":1}]}');
    expect(hashNormalizedJson({ a: 1, b: 2 })).toBe(hashNormalizedJson({ b: 2, a: 1 }));
    expect(hashNormalizedJson([1, 2])).not.toBe(hashNormalizedJson([2, 1]));
  });
  it("inserts only normalized change JSON and digest identity, then replays exactly", async () => {
    const w = actionWorld();
    const args = { operation: "preview_change" as const, input: move, travelerId: ids.actor, authorityDecision: "allowed" as const };
    const first = await beginAction(w.context, args);
    const replay = await beginAction(w.context, { ...args, input: Object.fromEntries(Object.entries(move).reverse()) });
    expect(first).toMatchObject({ ok: true, data: { replayed: false, action: { id: ids.action } } });
    expect(replay).toMatchObject({ ok: true, data: { replayed: true, action: { id: ids.action } } });
    expect(w.rows.trip_agent_actions).toHaveLength(1);
    expect(w.rows.trip_agent_actions[0].normalized_request).toEqual({ kind: "move", itemId: ids.item, toDayIndex: 1, toBlock: "dinner" });
    expect(JSON.stringify(w.rows.trip_agent_actions)).not.toMatch(/raw-group|raw-person|externalParticipantId|externalGroupId|requestId/);
  });
  it("rejects changed requests or actors with a reused key", async () => {
    const w = actionWorld();
    const args = { operation: "preview_change" as const, input: move, travelerId: ids.actor, authorityDecision: "allowed" as const };
    await beginAction(w.context, args);
    for (const input of [{ ...move, toDayIndex: 2 }, { ...move, externalParticipantId: "other" }]) {
      expect(await beginAction(w.context, { ...args, input })).toEqual({ ok: false, error: { code: "idempotency_conflict", message: expect.any(String), retryable: false } });
    }
    w.rows.trip_agent_actions[0].operation = "commit_change";
    expect(await beginAction(w.context, args)).toEqual({ ok: false, error: { code: "idempotency_conflict", message: expect.any(String), retryable: false } });
  });
  it("treats mixed-case UUIDs as one command identity across operations", async () => {
    const w = actionWorld();
    const requestId = "7A000000-0000-4000-8000-000000000001";
    const preview = {
      operation: "preview_change" as const,
      input: { ...move, requestId },
      travelerId: ids.actor,
      authorityDecision: "allowed" as const,
    };

    expect(await beginAction(w.context, preview)).toMatchObject({ ok: true, data: { replayed: false } });
    expect(await beginAction(w.context, {
      operation: "vote",
      input: { ...envelope, requestId: requestId.toLowerCase(), actionId: ids.action, vote: "up" },
      travelerId: ids.actor,
      authorityDecision: "allowed",
    })).toEqual({ ok: false, error: { code: "idempotency_conflict", message: expect.any(String), retryable: false } });
    expect(w.rows.trip_agent_actions).toHaveLength(1);
    expect(w.rows.trip_agent_actions[0]).toMatchObject({ idempotency_key: requestId.toLowerCase(), operation: "preview_change" });
  });
  it("allows a request id to be reused only after a replacement creates a fresh lifecycle", async () => {
    const w = actionWorld();
    w.rows.trip_agent_actions.push({
      id: "old-action", connection_id: ids.connection, trip_id: ids.trip, lifecycle_generation: 1,
      idempotency_key: ids.request, external_actor_digest: "old-actor", operation: "preview_change",
      normalized_request: {}, authority_decision: "allowed", status: "succeeded",
    });
    w.context.connection.lifecycleGeneration = 2;
    w.rows.trip_agent_connections[0].lifecycle_generation = 2;
    w.rows.trip_agent_connections[0].whatsapp_group_digest = digestExternalIdentity(ids.connection, 2, envelope.externalGroupId);
    w.context.connection.whatsappGroupDigest = w.rows.trip_agent_connections[0].whatsapp_group_digest as string;
    w.rows.trip_agent_participant_mappings[0].lifecycle_generation = 2;
    w.rows.trip_agent_participant_mappings[0].external_participant_digest = digestExternalIdentity(ids.connection, 2, envelope.externalParticipantId);

    const result = await beginAction(w.context, {
      operation: "preview_change", input: move, travelerId: ids.actor, authorityDecision: "allowed",
    });

    expect(result).toMatchObject({ ok: true, data: { replayed: false } });
    expect(w.rows.trip_agent_actions).toHaveLength(2);
    expect(w.rows.trip_agent_actions[1]).toMatchObject({ lifecycle_generation: 2, idempotency_key: ids.request });
  });
  it("validates the group and refuses unexpected private keys before writing", async () => {
    const w = actionWorld();
    for (const input of [{ ...move, externalGroupId: "wrong" }, { ...move, token: "secret" }]) {
      expect((await beginAction(w.context, { operation: "preview_change", input, travelerId: ids.actor, authorityDecision: "allowed" })).ok).toBe(false);
    }
    expect(w.writes).toHaveLength(0);
  });
  it("returns bounded failure for insert and duplicate-read failures", async () => {
    const w = actionWorld();
    const args = { operation: "preview_change" as const, input: { ...envelope, kind: "suggest" as const, text: "Museum" }, travelerId: ids.actor, authorityDecision: "allowed" as const };
    w.fail(() => true);
    expect(await beginAction(w.context, args)).toEqual({ ok: false, error: { code: "database_unavailable", message: expect.any(String), retryable: false } });
    w.fail(undefined); await beginAction(w.context, args);
    w.fail((table, operation) => table === "trip_agent_actions" && operation === "read");
    expect(await beginAction(w.context, args)).toEqual({ ok: false, error: { code: "database_unavailable", message: expect.any(String), retryable: false } });
  });
});
