/**
 * Who has engaged with the plan.
 *
 * Swaps are vote-gated, so a stop only unlocks once the group votes it down.
 * Knowing who has not voted is what tells an organiser whom to nudge before
 * anything can change.
 *
 * Counts come from the board's own payload rather than another query: every item
 * already arrives with its votes attached.
 */

export type VotedItem = { votes: { travelerId: string; value: number }[] };

/**
 * Votes cast per traveller across the current plan.
 *
 * 👍 and 👎 count the same — both are participation. Travellers who have not
 * voted are simply absent from the map.
 *
 * Reflects *current* stops only: votes are deleted when a stop is swapped or the
 * plan regenerated, so someone who voted before a regeneration reads as zero.
 */
export function countVotesByTraveler(items: VotedItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const vote of item.votes) {
      counts.set(vote.travelerId, (counts.get(vote.travelerId) ?? 0) + 1);
    }
  }
  return counts;
}
