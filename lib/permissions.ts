/**
 * Who may do what to a shared plan.
 *
 * Pure and I/O-free so the API routes and the board can import the same rules —
 * the button and the server can then never disagree. The server still calls
 * these itself: the API is public, so a disabled button is a courtesy, not a
 * control.
 */

export type Permission = { allowed: boolean; reason: string };

const ALLOWED: Permission = { allowed: true, reason: "" };

export const SWAP_LOCKED_REASON = "Needs the group to vote it down first";

/**
 * A venue can only be replaced once the group has rejected it, so nobody can
 * overwrite a choice the others liked.
 *
 * A tie and an unvoted block both stay locked: absence of objection is not
 * rejection.
 */
export function canSwap(args: {
  voteSum: number;
  isOrganizer: boolean;
  travelerCount: number;
}): Permission {
  // The organizer can already regenerate the whole plan; gating one block would be theatre.
  if (args.isOrganizer) return ALLOWED;
  // Nobody to disagree with — don't make a solo planner downvote their own trip.
  if (args.travelerCount < 2) return ALLOWED;
  if (args.voteSum < 0) return ALLOWED;
  return { allowed: false, reason: SWAP_LOCKED_REASON };
}

/**
 * Only the organizer prunes the traveller list, and never themselves — that
 * would leave the trip with nobody able to regenerate it.
 */
export function canRemoveTraveler(args: {
  actorIsOrganizer: boolean;
  actorId: string;
  targetId: string;
}): Permission {
  if (!args.actorIsOrganizer) {
    return { allowed: false, reason: "Only the organiser can remove a traveller" };
  }
  if (args.actorId === args.targetId) {
    return { allowed: false, reason: "You can't remove yourself — the trip needs an organiser" };
  }
  return ALLOWED;
}

/** Only the organiser names the trip — the title is what everyone else sees shared. */
export function canRenameTrip(args: { actorIsOrganizer: boolean }): Permission {
  if (!args.actorIsOrganizer) {
    return { allowed: false, reason: "Only the organiser can rename the trip" };
  }
  return ALLOWED;
}

/** Members own their suggestions; the organiser can moderate the shared list. */
export function canDeleteSuggestion(args: {
  actorIsOrganizer: boolean;
  actorId: string;
  suggestionOwnerId: string;
}): Permission {
  if (args.actorIsOrganizer || args.actorId === args.suggestionOwnerId) return ALLOWED;
  return { allowed: false, reason: "You can only remove your own suggestion" };
}

/**
 * Locking a booking, reshuffling the shared calendar, and moving a single
 * activity are organizer decisions.
 *
 * Travellers get their say through proposals and votes rather than by writing
 * to the shared plan directly — see the group change protocol. Until that
 * exists, every write to the canonical plan runs through here.
 */
export function canManageSchedule(args: { actorIsOrganizer: boolean }): Permission {
  if (args.actorIsOrganizer) return ALLOWED;
  return { allowed: false, reason: "Only the organiser can lock, move, or reshuffle activities" };
}

/** Connector credentials and lifecycle state belong to a human trip organiser. */
export function canManageTripAgent(args: {
  actorIsOrganizer: boolean;
  actorIsBot: boolean;
}): Permission {
  if (args.actorIsOrganizer && !args.actorIsBot) return ALLOWED;
  return { allowed: false, reason: "Only the organiser can manage the trip agent" };
}
