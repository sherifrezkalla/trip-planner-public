import { describe, expect, it } from "vitest";
import {
  activateTripAgentInputSchema,
  authorityPolicySchema,
  commitTripChangeInputSchema,
  decideTripChangeInputSchema,
  getPendingTripDecisionsInputSchema,
  getTodayPlanInputSchema,
  getTripAgentReadinessInputSchema,
  getTripContextInputSchema,
  pollProactiveEventsInputSchema,
  previewTripChangeInputSchema,
  registerTripGroupInputSchema,
  reportGroupAnnouncementInputSchema,
  searchTripOptionsInputSchema,
  TRIP_AGENT_ACTION_STATUSES,
  tripAgentProviderSchema,
  tripChangeSchema,
  voteOnTripChangeInputSchema,
} from "@/lib/trip-agent-contracts";

const requestId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const base = { requestId, externalGroupId: "group-123" };
const toolInputs = [
  [registerTripGroupInputSchema, { ...base, groupLabel: "Family trip", participants: [] }],
  [getTripAgentReadinessInputSchema, base],
  [activateTripAgentInputSchema, { ...base, privacyNoticeVersion: "v1", deliveryReceiptId: "receipt-1" }],
  [getTripContextInputSchema, base],
  [getTodayPlanInputSchema, base],
  [searchTripOptionsInputSchema, { ...base, kind: "place", query: "museum" }],
  [getPendingTripDecisionsInputSchema, base],
  [previewTripChangeInputSchema, { ...base, externalParticipantId: "person-1", kind: "suggest", text: "Try a museum" }],
  [commitTripChangeInputSchema, { externalGroupId: base.externalGroupId, externalParticipantId: "person-1", actionId: requestId }],
  [voteOnTripChangeInputSchema, { ...base, externalParticipantId: "person-1", actionId: requestId, vote: "up" }],
  [decideTripChangeInputSchema, { ...base, externalParticipantId: "person-1", actionId: requestId, decision: "approve" }],
  [reportGroupAnnouncementInputSchema, {
    ...base,
    actionId: requestId,
    deliveryStatus: "delivered",
    providerMessageId: "message-1",
  }],
  [pollProactiveEventsInputSchema, base],
] as const;

describe("trip-agent contracts", () => {
  it("rejects unsupported reservation notes without stripping them from an accepted request", () => {
    const change = { kind: "reservation_prepare", itemId: requestId, partySize: 4, requestedAt: "2026-09-01T10:00:00Z" };
    expect(tripChangeSchema.parse(change)).toEqual(change);
    expect(previewTripChangeInputSchema.parse({ ...base, externalParticipantId: "person-1", ...change }))
      .toEqual({ ...base, externalParticipantId: "person-1", ...change });
    for (const note of ["Private reservation request", "", null]) {
      expect(tripChangeSchema.safeParse({ ...change, note }).success).toBe(false);
      expect(previewTripChangeInputSchema.safeParse({ ...base, externalParticipantId: "person-1", ...change, note }).success).toBe(false);
    }
  });

  it.each([
    { kind: "move", itemId: requestId, toDayIndex: 1, toBlock: "dinner" },
    { kind: "replace", itemId: requestId, replacementCandidateId: "replacement" },
  ])("preserves supported notes for $kind changes", change => {
    const input = { ...change, note: " Keep the group together " };
    expect(tripChangeSchema.parse(input)).toEqual({ ...change, note: "Keep the group together" });
    expect(previewTripChangeInputSchema.parse({ ...base, externalParticipantId: "person-1", ...input }))
      .toEqual({ ...base, externalParticipantId: "person-1", ...change, note: "Keep the group together" });
  });

  it("commits only an existing preview ID and refuses a repeated change payload", () => {
    const commit = { externalGroupId: base.externalGroupId, externalParticipantId: "person-1", actionId: requestId };
    expect(commitTripChangeInputSchema.safeParse(commit).success).toBe(true);
    expect(commitTripChangeInputSchema.safeParse({ ...commit, requestId }).success).toBe(false);
    expect(commitTripChangeInputSchema.safeParse({ ...commit, actionId: "" }).success).toBe(false);
    expect(commitTripChangeInputSchema.safeParse({ ...commit, kind: "suggest", text: "museum" }).success).toBe(false);
    expect(commitTripChangeInputSchema.safeParse({ ...base, externalParticipantId: "person-1", kind: "suggest", text: "museum" }).success).toBe(false);
  });
  it("accepts only supported connector providers", () => {
    expect(tripAgentProviderSchema.safeParse("openclaw").success).toBe(true);
    expect(tripAgentProviderSchema.safeParse("hermes").success).toBe(true);
    expect(tripAgentProviderSchema.safeParse("other").success).toBe(false);
  });

  it("exposes the migration's exact durable action state machine", () => {
    expect(TRIP_AGENT_ACTION_STATUSES).toEqual([
      "received",
      "previewed",
      "executing",
      "succeeded",
      "awaiting_vote",
      "awaiting_confirmation",
      "rejected",
      "cancelled",
      "refused",
      "expired",
      "failed",
      "unknown",
    ]);
  });

  it("gives every MCP tool a strict idempotency envelope and nonempty external group", () => {
    for (const [schema, input] of toolInputs) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, requestId: "not-a-uuid" }).success).toBe(false);
      expect(schema.safeParse({ ...input, externalGroupId: "" }).success).toBe(false);
    }
  });

  it("rejects an unknown key on every MCP tool input", () => {
    for (const [schema, input] of toolInputs) {
      expect(schema.safeParse({ ...input, unexpected: true }).success).toBe(false);
    }
  });

  it("requires a nonempty participant ID for participant-authorized writes", () => {
    const inputs = [
      [previewTripChangeInputSchema, { ...base, externalParticipantId: "person-1", kind: "suggest", text: "Try a museum" }],
      [commitTripChangeInputSchema, { externalGroupId: base.externalGroupId, externalParticipantId: "person-1", actionId: requestId }],
      [voteOnTripChangeInputSchema, { ...base, externalParticipantId: "person-1", actionId: requestId, vote: "up" }],
      [decideTripChangeInputSchema, { ...base, externalParticipantId: "person-1", actionId: requestId, decision: "approve" }],
    ] as const;

    for (const [schema, input] of inputs) {
      expect(schema.safeParse({ ...input, externalParticipantId: "" }).success).toBe(false);
      const withoutParticipant = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "externalParticipantId"));
      expect(schema.safeParse(withoutParticipant).success).toBe(false);
    }

    expect(getTripContextInputSchema.safeParse(base).success).toBe(true);
    expect(getTripContextInputSchema.safeParse({ ...base, externalParticipantId: "" }).success).toBe(false);
  });

  it("limits change kinds and free text at the gateway boundary", () => {
    const suggestion = { ...base, externalParticipantId: "person-1", kind: "suggest", text: "Try a museum" };

    expect(previewTripChangeInputSchema.safeParse(suggestion).success).toBe(true);
    expect(previewTripChangeInputSchema.safeParse({ ...suggestion, kind: "book" }).success).toBe(false);
    expect(previewTripChangeInputSchema.safeParse({ ...suggestion, text: "x".repeat(241) }).success).toBe(false);
  });

  it("accepts only bounded announcement delivery reports", () => {
    const delivered = {
      ...base,
      actionId: requestId,
      deliveryStatus: "delivered",
      providerMessageId: "message-1",
    };

    expect(reportGroupAnnouncementInputSchema.safeParse(delivered).success).toBe(true);
    expect(reportGroupAnnouncementInputSchema.safeParse({
      ...delivered,
      deliveryStatus: "failed",
      providerMessageId: undefined,
    }).success).toBe(true);
    expect(reportGroupAnnouncementInputSchema.safeParse({
      ...delivered,
      deliveryStatus: "pending",
    }).success).toBe(false);
    expect(reportGroupAnnouncementInputSchema.safeParse({
      ...delivered,
      providerMessageId: "x".repeat(241),
    }).success).toBe(false);
  });

  it("rejects unknown input keys and keeps the authority policy bounded", () => {
    expect(searchTripOptionsInputSchema.safeParse({ ...base, query: "museum", extra: true }).success).toBe(false);
    expect(authorityPolicySchema.parse({})).toEqual({
      travelerCanAddSuggestion: true,
      travelerCanProposeChange: true,
    });
    expect(authorityPolicySchema.safeParse({ travelerCanAddSuggestion: true, extra: true }).success).toBe(false);
  });

  it("accepts only explicit research modes and normalizes bounded text", () => {
    for (const kind of ["place", "restaurant"] as const) {
      expect(searchTripOptionsInputSchema.parse({ ...base, kind, query: " museum " }))
        .toEqual({ ...base, kind, query: "museum" });
      for (const query of ["", "   ", "x".repeat(241)]) {
        expect(searchTripOptionsInputSchema.safeParse({ ...base, kind, query }).success).toBe(false);
      }
    }
    expect(searchTripOptionsInputSchema.safeParse({ ...base, kind: "parking", location: " Old Port " }).success).toBe(true);
    for (const input of [
      { query: "museum" }, { kind: "hotel", query: "museum" },
      { kind: "parking", query: "Old Port" }, { kind: "parking", location: " " },
      { kind: "parking", location: "x".repeat(241) },
      { kind: "place", query: "museum", location: "Old Port" },
    ]) expect(searchTripOptionsInputSchema.safeParse({ ...base, ...input }).success).toBe(false);
  });

  it("accepts item or coordinate route endpoints and rejects mixed, unsafe, or extra shapes", () => {
    const route = { ...base, kind: "route", origin: { itemId: requestId }, destination: { lat: 0, lng: 180, label: "Port" } };
    expect(searchTripOptionsInputSchema.safeParse(route).success).toBe(true);
    expect(searchTripOptionsInputSchema.safeParse({ ...route, origin: { lat: -90, lng: -180 } }).success).toBe(true);
    for (const endpoint of [
      {}, { itemId: "bad-id" }, { itemId: requestId, lat: 1, lng: 2 },
      { itemId: requestId, label: "Override" }, { lat: 1 }, { lat: "1", lng: 2 },
      { lat: Infinity, lng: 2 }, { lat: NaN, lng: 2 }, { lat: 91, lng: 2 },
      { lat: 1, lng: -181 }, { lat: 1, lng: 2, url: "https://evil.test" },
      { lat: 1, lng: 2, label: "x".repeat(241) },
    ]) {
      expect(searchTripOptionsInputSchema.safeParse({ ...route, origin: endpoint }).success).toBe(false);
      expect(searchTripOptionsInputSchema.safeParse({ ...route, destination: endpoint }).success).toBe(false);
    }
    expect(searchTripOptionsInputSchema.safeParse({ ...route, query: "route" }).success).toBe(false);
    expect(searchTripOptionsInputSchema.safeParse({ ...route, travelMode: "WALK" }).success).toBe(false);
  });
});
