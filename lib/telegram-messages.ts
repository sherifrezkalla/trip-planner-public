/**
 * What the organizer's phone actually says.
 *
 * Pure and I/O-free so the wording can be tested without a network, and so the
 * decision about what is worth waking someone for stays separate from the
 * mechanics of sending it.
 *
 * Messages are plain text with no parse mode. Venue names come from Google and
 * notes are written by travellers, so anything with markup would need escaping
 * that, done wrong, either mangles a name or drops the message entirely. Bold
 * is not worth that.
 */

import type { ProposalKind } from "./proposals";

export type TelegramButton = { text: string; callbackData: string };

export type TelegramMessage = {
  text: string;
  buttons: TelegramButton[];
};

export type ProposalSummary = {
  proposalId: string;
  kind: ProposalKind;
  venueName: string;
  /** The stand-in a `replace` names. Null for the other kinds, or if it is gone. */
  replacementName: string | null;
  suggestionText?: string | null;
  proposedByName: string;
  note: string;
  fromDayIndex: number | null;
  fromBlock: string | null;
  toDayIndex: number | null;
  toBlock: string | null;
};

/**
 * "move Grama Bay to Day 12 evening" / "drop Grama Bay from Day 12" /
 * "swap Grama Bay for Musee Picasso on Day 12"
 *
 * Every kind is spelled out. This used to end in a bare `return` for the move
 * wording, so `replace` — which carries no destination slot — described itself
 * as "move Grama Bay to Day 1 null" and never named the stand-in. The organizer
 * approves from this sentence, so a kind it does not know must not borrow the
 * wording of one it does; the switch is exhaustive to keep the next kind honest.
 */
export function describeChange(summary: ProposalSummary): string {
  const day = (summary.fromDayIndex ?? 0) + 1;
  switch (summary.kind) {
    case "remove":
      return `drop ${summary.venueName} from Day ${day}`;
    case "move":
      return `move ${summary.venueName} to Day ${(summary.toDayIndex ?? 0) + 1} ${summary.toBlock}`;
    case "replace":
      return `swap ${summary.venueName} for ${summary.replacementName ?? "another venue"} on Day ${day}`;
    case "suggest":
      return `add ${summary.suggestionText ?? "this idea"} to the trip suggestions`;
  }
}

/**
 * A request is waiting. The only message with buttons — the other two report
 * something already settled, where a button would just be a trap.
 */
export function requestOpenedMessage(
  summary: ProposalSummary,
  tally: { yes: number; needed: number },
): TelegramMessage {
  const lines = [
    `${summary.proposedByName} asked to ${describeChange(summary)}.`,
  ];
  if (summary.note) lines.push("", `"${summary.note}"`);
  lines.push("", `${tally.yes} of ${tally.needed} needed to carry it.`);

  return {
    text: lines.join("\n"),
    buttons: [
      { text: "Approve", callbackData: `approve:${summary.proposalId}` },
      { text: "Turn down", callbackData: `reject:${summary.proposalId}` },
    ],
  };
}

/**
 * The group changed the plan without the organizer.
 *
 * This is the message that keeps a vote threshold from meaning the plan moves
 * behind their back. Nothing to decide, so nothing to press.
 */
export function appliedByVoteMessage(
  summary: ProposalSummary,
  tally: { yes: number; travelerCount: number },
): TelegramMessage {
  return {
    text: [
      `The group agreed to ${describeChange(summary)}.`,
      "",
      `${tally.yes} of ${tally.travelerCount} travellers agreed. The plan has changed.`,
    ].join("\n"),
    buttons: [],
  };
}

/** A request died on its own. Said plainly so nobody waits on it. */
export function cancelledMessage(
  summary: ProposalSummary,
  reason: string,
): TelegramMessage {
  return {
    text: [
      `${summary.proposedByName}'s request to ${describeChange(summary)} was cancelled.`,
      "",
      reason,
    ].join("\n"),
    buttons: [],
  };
}

/** Replaces the original message once a button has been pressed. */
export function decidedMessage(summary: ProposalSummary, outcome: string): string {
  return [`Request to ${describeChange(summary)}.`, "", outcome].join("\n");
}

export function linkedMessage(tripTitle: string): string {
  return [
    `Linked to ${tripTitle}.`,
    "",
    "You'll get a message here when a traveller asks to change the plan, when the group agrees one without you, and when a request cancels itself.",
  ].join("\n");
}

export const LINK_CODE_REJECTED =
  "That link has expired or was already used. Open the trip and tap Get Telegram alerts again.";
