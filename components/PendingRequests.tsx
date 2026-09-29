"use client";

/**
 * The queue of open change requests.
 *
 * Shown to everyone, not just the organiser. A traveller who asked for a change
 * needs to see that it is waiting and how close it is; without that the "did
 * anyone see this?" conversation moves to WhatsApp, which is exactly the leak
 * this is meant to close.
 */

import type { ProposalKind } from "@/lib/proposals";

export type PendingProposal = {
  id: string;
  itemId: string | null;
  kind: ProposalKind;
  proposedByName: string;
  fromDayIndex: number | null;
  fromBlock: string | null;
  toDayIndex: number | null;
  toBlock: string | null;
  /** The stand-in a `replace` names. Null for the other kinds, or if it is gone. */
  replacementName: string | null;
  suggestionText?: string | null;
  note: string;
  createdAt: string;
  yes: number;
  no: number;
  needed: number;
  myVote: number;
};

/**
 * The one line the group votes on, and the organizer approves from.
 *
 * Every kind is spelled out. The move wording used to be a bare fallthrough, so
 * `replace` — raised by the weather scan, and carrying no destination slot —
 * read as "Move beach to Day 1 null" and never named the venue being proposed.
 * Approving a change you were shown incorrectly is the failure this guards, so
 * the switch is exhaustive: a kind added later has to say what it means here
 * rather than quietly inheriting the wording of a different one.
 */
export function describeProposal(proposal: PendingProposal, venueName: string): string {
  const day = (proposal.fromDayIndex ?? 0) + 1;
  switch (proposal.kind) {
    case "remove":
      return `Drop ${venueName} from Day ${day}`;
    case "move":
      return `Move ${venueName} to Day ${(proposal.toDayIndex ?? 0) + 1} ${proposal.toBlock}`;
    case "replace":
      return `Swap ${venueName} for ${proposal.replacementName ?? "another venue"} on Day ${day}`;
    case "suggest":
      return `Add ${proposal.suggestionText ?? "this idea"} to the group's suggestions`;
  }
}

export default function PendingRequests({
  proposals,
  venueNameById,
  isOrganizer,
  busyId,
  onVote,
  onDecide,
}: {
  proposals: PendingProposal[];
  venueNameById: Map<string, string>;
  isOrganizer: boolean;
  busyId: string;
  onVote: (proposal: PendingProposal, value: 1 | -1) => void;
  onDecide: (proposal: PendingProposal, decision: "approve" | "reject") => void;
}) {
  if (proposals.length === 0) return null;

  return (
    <section className="mb-4 rounded-2xl border border-[#D9C49E] bg-[#FFF9EE] p-4">
      <h2 className="font-display text-lg font-semibold text-[#2D2A24]">
        {proposals.length === 1 ? "1 change waiting" : `${proposals.length} changes waiting`}
      </h2>
      <p className="mt-1 text-sm text-[#8A8272]">
        {isOrganizer
          ? "Approve to apply straight away, or let the group vote."
          : "A change applies once more than half the group agrees."}
      </p>

      <ul className="mt-3 flex flex-col gap-3">
        {proposals.map((proposal) => {
          const busy = busyId === proposal.id;
          const venueName = proposal.itemId ? venueNameById.get(proposal.itemId) ?? "an activity" : "an activity";
          return (
            <li
              key={proposal.id}
              className="rounded-xl border border-[#EADFCC] bg-[#FFFDF8] p-3"
            >
              <p className="font-semibold text-[#2D2A24]">
                {describeProposal(proposal, venueName)}
              </p>
              <p className="mt-0.5 text-sm text-[#8A8272]">
                asked by {proposal.proposedByName}
                {proposal.kind === "remove" || proposal.kind === "suggest"
                  ? ""
                  : ` · now on Day ${(proposal.fromDayIndex ?? 0) + 1} ${proposal.fromBlock}`}
              </p>
              {proposal.note && (
                <p className="mt-1 text-sm italic text-[#2D2A24]">“{proposal.note}”</p>
              )}

              <p className="mt-2 text-sm font-medium text-[#5F7A54]">
                {proposal.yes} of {proposal.needed} needed
                {proposal.no > 0 ? ` · ${proposal.no} against` : ""}
              </p>

              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <button
                  onClick={() => onVote(proposal, 1)}
                  disabled={busy}
                  className={`w-full rounded-full px-3 py-2 text-sm font-semibold transition disabled:opacity-50 sm:w-auto sm:py-1 ${
                    proposal.myVote === 1
                      ? "bg-[#E4EDDD] text-[#46613D] ring-1 ring-[#5F7A54]"
                      : "border border-[#EADFCC] text-[#2D2A24] hover:bg-[#F3E0D3]"
                  }`}
                >
                  👍 Agree
                </button>
                <button
                  onClick={() => onVote(proposal, -1)}
                  disabled={busy}
                  className={`w-full rounded-full px-3 py-2 text-sm font-semibold transition disabled:opacity-50 sm:w-auto sm:py-1 ${
                    proposal.myVote === -1
                      ? "bg-[#F3E0D3] text-[#8A4A15] ring-1 ring-[#C2571B]"
                      : "border border-[#EADFCC] text-[#2D2A24] hover:bg-[#F3E0D3]"
                  }`}
                >
                  👎 Not this
                </button>

                {isOrganizer && (
                  <>
                    <button
                      onClick={() => onDecide(proposal, "approve")}
                      disabled={busy}
                      className="w-full rounded-full bg-[#5F7A54] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#4C6544] disabled:opacity-50 sm:w-auto sm:py-1"
                    >
                      {busy ? "Working…" : "Approve now"}
                    </button>
                    <button
                      onClick={() => onDecide(proposal, "reject")}
                      disabled={busy}
                      className="w-full rounded-full border border-[#D9C49E] px-3 py-2 text-sm text-[#8A6D1F] transition hover:bg-[#F5E6C8] disabled:opacity-50 sm:w-auto sm:py-1"
                    >
                      Turn down
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
