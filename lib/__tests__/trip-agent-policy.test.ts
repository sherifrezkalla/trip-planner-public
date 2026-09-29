import { describe, expect, it } from "vitest";

import { evaluateTripAgentAuthority } from "@/lib/trip-agent-policy";
import type { TripAgentOperation, TripAgentScope } from "@/lib/trip-agent-contracts";

const fullScopes: TripAgentScope[] = [
  "connector.setup",
  "trip.read",
  "trip.research",
  "trip.propose",
  "trip.modify",
  "trip.vote",
  "proactive.read",
  "announcement.write",
];

const policy = {
  travelerCanAddSuggestion: true,
  travelerCanProposeChange: true,
};

const unmatched = null;
const traveler = {
  status: "confirmed" as const,
  traveler: { id: "traveler-1", isOrganizer: false, isBot: false },
};
const organizer = {
  status: "confirmed" as const,
  traveler: { id: "organizer-1", isOrganizer: true, isBot: false },
};

function input(
  operation: TripAgentOperation,
  overrides: Record<string, unknown> = {},
) {
  return {
    operation,
    connection: { status: "active" as const, grantedScopes: fullScopes },
    mapping: traveler,
    authorityPolicy: policy,
    ...overrides,
  };
}

describe("evaluateTripAgentAuthority default policy", () => {
  it.each(["vote", "decide"] as const)("denies a legacy bot organizer attempting %s", operation => {
    expect(evaluateTripAgentAuthority(input(operation, {
      mapping: { ...organizer, traveler: { ...organizer.traveler, isBot: true } },
    }))).toMatchObject({ decision: "denied", reason: "automated_travelers_cannot_vote" });
  });
  it.each([
    ["read_context", "trip.read"],
    ["read_today", "trip.read"],
    ["read_decisions", "trip.read"],
    ["search_options", "trip.research"],
  ] as const)("allows an unmatched participant to %s with group-safe data", (operation, requiredScope) => {
    expect(evaluateTripAgentAuthority(input(operation, { mapping: unmatched }))).toEqual({
      decision: "allowed",
      reason: "group_safe_read",
      requiredScope,
    });
  });

  it.each([
    ["commit_change", "trip.propose"],
    ["vote", "trip.vote"],
    ["decide", "trip.vote"],
  ] as const)("denies an unmatched participant attempting %s", (operation, requiredScope) => {
    const result = evaluateTripAgentAuthority(input(operation, {
      mapping: unmatched,
      ...(operation === "commit_change" ? { changeKind: "move" } : {}),
    }));
    expect(result).toEqual({
      decision: "denied",
      reason: "confirmed_mapping_required",
      requiredScope,
    });
  });

  it("allows a confirmed traveler to preview a change", () => {
    expect(evaluateTripAgentAuthority(input("preview_change", { changeKind: "move" }))).toEqual({
      decision: "allowed",
      reason: "confirmed_traveler_preview",
      requiredScope: "trip.propose",
    });
  });

  it.each(["move", "remove", "replace"] as const)(
    "routes a confirmed traveler's reversible %s commit through the proposal path",
    (changeKind) => {
      expect(evaluateTripAgentAuthority(input("commit_change", { changeKind }))).toEqual({
        decision: "allowed",
        reason: "traveler_change_preauthorized",
        requiredScope: "trip.propose",
      });
    },
  );

  it("allows a confirmed human traveler to vote", () => {
    expect(evaluateTripAgentAuthority(input("vote"))).toEqual({
      decision: "allowed",
      reason: "confirmed_human_traveler_vote",
      requiredScope: "trip.vote",
    });
  });

  it.each(["move", "remove", "replace"] as const)(
    "allows the confirmed organizer to commit a reversible %s after preview",
    (changeKind) => {
      expect(evaluateTripAgentAuthority(input("commit_change", { mapping: organizer, changeKind }))).toEqual({
        decision: "allowed",
        reason: "organizer_reversible_change",
        requiredScope: "trip.modify",
      });
    },
  );

  it.each([unmatched, traveler, organizer])(
    "requires organizer confirmation for reservation preparation",
    (mapping) => {
      expect(evaluateTripAgentAuthority(input("commit_change", {
        mapping,
        changeKind: "reservation_prepare",
      })).decision).toBe(mapping ? "requires_organizer_confirmation" : "denied");
    },
  );
});

describe("evaluateTripAgentAuthority boundary gates", () => {
  it.each([
    ["register_group", "connector.setup"],
    ["readiness", "connector.setup"],
    ["activate", "connector.setup"],
    ["read_context", "trip.read"],
    ["read_today", "trip.read"],
    ["search_options", "trip.research"],
    ["read_decisions", "trip.read"],
    ["preview_change", "trip.propose"],
    ["commit_change", "trip.propose"],
    ["vote", "trip.vote"],
    ["decide", "trip.vote"],
    ["report_announcement", "announcement.write"],
    ["poll_proactive_events", "proactive.read"],
  ] as const)("maps %s to only its normative scope", (operation, requiredScope) => {
    const mapping = operation === "decide" ? organizer : traveler;
    const result = evaluateTripAgentAuthority(input(operation, {
      mapping,
      ...(operation === "commit_change" ? { changeKind: "move" } : {}),
    }));
    expect(result.requiredScope).toBe(requiredScope);
  });

  it.each(["register_group", "readiness", "activate"] as const)(
    "allows paired connectors to call setup operation %s",
    (operation) => {
      expect(evaluateTripAgentAuthority(input(operation, {
        connection: { status: "paired", grantedScopes: ["connector.setup"] },
        mapping: unmatched,
      })).decision).toBe("allowed");
    },
  );

  it.each(["read_context", "preview_change", "vote"] as const)(
    "denies ordinary operation %s while the connector is only paired",
    (operation) => {
      expect(evaluateTripAgentAuthority(input(operation, {
        connection: { status: "paired", grantedScopes: fullScopes },
      }))).toMatchObject({ decision: "denied", reason: "connection_not_active" });
    },
  );

  it("denies paused connections even when scopes and identity are valid", () => {
    expect(evaluateTripAgentAuthority(input("read_context", {
      connection: { status: "paused", grantedScopes: fullScopes },
    }))).toMatchObject({ decision: "denied", reason: "connection_unavailable" });
  });

  it("denies a call missing its exact scope", () => {
    expect(evaluateTripAgentAuthority(input("search_options", {
      connection: { status: "active", grantedScopes: ["trip.read"] },
    }))).toEqual({
      decision: "denied",
      reason: "missing_scope",
      requiredScope: "trip.research",
    });
  });

  it("never allows an automated traveler to vote", () => {
    expect(evaluateTripAgentAuthority(input("vote", {
      mapping: {
        status: "confirmed",
        traveler: { id: "bot-1", isOrganizer: false, isBot: true },
      },
    }))).toEqual({
      decision: "denied",
      reason: "automated_travelers_cannot_vote",
      requiredScope: "trip.vote",
    });
  });

  it.each(["move", "remove", "replace", "suggest"] as const)(
    "denies an automated traveler's %s commit because the proposal path records a yes vote",
    (changeKind) => {
      expect(evaluateTripAgentAuthority(input("commit_change", {
        changeKind,
        mapping: {
          status: "confirmed",
          traveler: { id: "bot-1", isOrganizer: false, isBot: true },
        },
      }))).toEqual({
        decision: "denied",
        reason: "automated_travelers_cannot_vote",
        requiredScope: "trip.propose",
      });
    },
  );

  it("keeps group-safe reads available to a confirmed automated traveler", () => {
    expect(evaluateTripAgentAuthority(input("read_context", {
      mapping: {
        status: "confirmed",
        traveler: { id: "bot-1", isOrganizer: false, isBot: true },
      },
    }))).toEqual({
      decision: "allowed",
      reason: "group_safe_read",
      requiredScope: "trip.read",
    });
  });

  it("allows decisions only for the organizer from a confirmed traveler row", () => {
    expect(evaluateTripAgentAuthority(input("decide"))).toMatchObject({
      decision: "denied",
      reason: "organizer_mapping_required",
    });
    expect(evaluateTripAgentAuthority(input("decide", { mapping: organizer }))).toMatchObject({
      decision: "allowed",
      reason: "confirmed_organizer_decision",
    });
  });

  it("does not infer organizer authority from a connector display name", () => {
    const claimedOrganizer = {
      status: "suggested" as const,
      displayNameHint: "Alex (Organizer)",
      traveler: null,
    };
    expect(evaluateTripAgentAuthority(input("decide", {
      mapping: claimedOrganizer,
    }))).toMatchObject({ decision: "denied", reason: "confirmed_mapping_required" });
  });

  it("applies only the bounded suggestion preauthorization", () => {
    expect(evaluateTripAgentAuthority(input("commit_change", {
      changeKind: "suggest",
      authorityPolicy: { ...policy, travelerCanAddSuggestion: false },
    }))).toEqual({
      decision: "requires_organizer_confirmation",
      reason: "traveler_suggestion_not_preauthorized",
      requiredScope: "trip.propose",
    });
  });

  it("applies only the bounded change-proposal preauthorization", () => {
    expect(evaluateTripAgentAuthority(input("commit_change", {
      changeKind: "move",
      authorityPolicy: { ...policy, travelerCanProposeChange: false },
    }))).toEqual({
      decision: "requires_organizer_confirmation",
      reason: "traveler_change_not_preauthorized",
      requiredScope: "trip.propose",
    });
  });
});
