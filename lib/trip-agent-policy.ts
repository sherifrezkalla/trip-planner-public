import type {
  AuthorityPolicy,
  TripAgentAuthorityDecision,
  TripAgentOperation,
  TripAgentScope,
} from "./trip-agent-contracts";

type ConnectionStatus = "pending" | "paired" | "active" | "paused" | "revoked" | "archived";
type ChangeKind = "move" | "remove" | "replace" | "suggest" | "reservation_prepare";

type ConfirmedMapping = {
  status: "confirmed";
  traveler: {
    id: string;
    isOrganizer: boolean;
    isBot: boolean;
  };
};

type UnconfirmedMapping = {
  status: "suggested" | "revoked";
  displayNameHint?: string | null;
  traveler?: null;
};

export type TripAgentAuthorityInput = {
  operation: TripAgentOperation;
  connection: {
    status: ConnectionStatus;
    grantedScopes: readonly TripAgentScope[];
  };
  mapping: ConfirmedMapping | UnconfirmedMapping | null;
  authorityPolicy: AuthorityPolicy;
  changeKind?: ChangeKind;
};

export type TripAgentAuthorityResult = {
  decision: TripAgentAuthorityDecision;
  reason: string;
  requiredScope: TripAgentScope;
};

const setupOperations = new Set<TripAgentOperation>(["register_group", "readiness", "activate"]);

function confirmedMapping(input: TripAgentAuthorityInput): ConfirmedMapping | null {
  return input.mapping?.status === "confirmed" && input.mapping.traveler
    ? input.mapping as ConfirmedMapping
    : null;
}

function requiredScope(input: TripAgentAuthorityInput): TripAgentScope {
  switch (input.operation) {
    case "register_group":
    case "readiness":
    case "activate":
      return "connector.setup";
    case "read_context":
    case "read_today":
    case "read_decisions":
      return "trip.read";
    case "search_options":
      return "trip.research";
    case "preview_change":
      return "trip.propose";
    case "commit_change": {
      const mapping = confirmedMapping(input);
      return mapping?.traveler.isOrganizer && input.changeKind !== "suggest"
        ? "trip.modify"
        : "trip.propose";
    }
    case "vote":
    case "decide":
      return "trip.vote";
    case "report_announcement":
      return "announcement.write";
    case "poll_proactive_events":
      return "proactive.read";
    default:
      return assertNever(input.operation);
  }
}

function result(
  decision: TripAgentAuthorityDecision,
  reason: string,
  scope: TripAgentScope,
): TripAgentAuthorityResult {
  return { decision, reason, requiredScope: scope };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported trip-agent operation: ${String(value)}`);
}

/**
 * Evaluate connector authority from authenticated, persisted state only.
 * Provider display names and identity claims are deliberately absent from the
 * authority-bearing input shape.
 */
export function evaluateTripAgentAuthority(input: TripAgentAuthorityInput): TripAgentAuthorityResult {
  const scope = requiredScope(input);
  const isSetup = setupOperations.has(input.operation);

  if (["paused", "revoked", "archived", "pending"].includes(input.connection.status)) {
    return result("denied", "connection_unavailable", scope);
  }
  if (input.connection.status === "paired" && !isSetup) {
    return result("denied", "connection_not_active", scope);
  }
  if (!input.connection.grantedScopes.includes(scope)) {
    return result("denied", "missing_scope", scope);
  }

  const mapping = confirmedMapping(input);
  switch (input.operation) {
    case "register_group":
    case "readiness":
    case "activate":
      return result("allowed", "setup_operation", scope);
    case "read_context":
    case "read_today":
    case "read_decisions":
    case "search_options":
      return result("allowed", "group_safe_read", scope);
    case "preview_change":
      return mapping
        ? result("allowed", "confirmed_traveler_preview", scope)
        : result("denied", "confirmed_mapping_required", scope);
    case "commit_change":
      if (!mapping) return result("denied", "confirmed_mapping_required", scope);
      if (mapping.traveler.isBot) {
        return result("denied", "automated_travelers_cannot_vote", scope);
      }
      if (input.changeKind === "reservation_prepare") {
        return result("requires_organizer_confirmation", "consequential_action", scope);
      }
      if (mapping.traveler.isOrganizer) {
        return result("allowed", "organizer_reversible_change", scope);
      }
      if (input.changeKind === "suggest") {
        return input.authorityPolicy.travelerCanAddSuggestion
          ? result("allowed", "traveler_suggestion_preauthorized", scope)
          : result("requires_organizer_confirmation", "traveler_suggestion_not_preauthorized", scope);
      }
      return input.authorityPolicy.travelerCanProposeChange
        ? result("allowed", "traveler_change_preauthorized", scope)
        : result("requires_organizer_confirmation", "traveler_change_not_preauthorized", scope);
    case "vote":
      if (!mapping) return result("denied", "confirmed_mapping_required", scope);
      if (mapping.traveler.isBot) {
        return result("denied", "automated_travelers_cannot_vote", scope);
      }
      return result("allowed", "confirmed_human_traveler_vote", scope);
    case "decide":
      if (!mapping) return result("denied", "confirmed_mapping_required", scope);
      if (mapping.traveler.isBot) return result("denied", "automated_travelers_cannot_vote", scope);
      return mapping.traveler.isOrganizer
        ? result("allowed", "confirmed_organizer_decision", scope)
        : result("denied", "organizer_mapping_required", scope);
    case "report_announcement":
      return result("allowed", "announcement_receipt", scope);
    case "poll_proactive_events":
      return result("allowed", "proactive_poll", scope);
    default:
      return assertNever(input.operation);
  }
}
