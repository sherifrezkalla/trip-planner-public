export type SuggestibleConciergeOutcome = {
  name: string;
};

/**
 * A shared suggestion requires only the traveller's text. Keep this conversion
 * deliberately narrow: an unnamed search result cannot be made meaningful by
 * guessing, and the suggestions endpoint owns the final validation.
 */
export function conciergeSuggestionText(
  outcome: SuggestibleConciergeOutcome,
): string | null {
  const name = outcome.name.trim().replace(/\s+/g, " ");
  if (!name || name === "Unknown" || name.length > 240) return null;
  return name;
}

export async function addConciergeOutcomeAsSuggestion(args: {
  slug: string;
  token: string;
  outcome: SuggestibleConciergeOutcome;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const text = conciergeSuggestionText(args.outcome);
  if (!text) throw new Error("This result does not have enough detail to suggest.");

  const response = await (args.fetchImpl ?? fetch)(`/api/trips/${args.slug}/suggestion-proposals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: args.token, text }),
  });
  if (response.ok) return;

  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error || "Could not add this suggestion.");
}
