import { describe, expect, it, vi } from "vitest";
import {
  addConciergeOutcomeAsSuggestion,
  conciergeSuggestionText,
} from "@/lib/concierge-outcomes";

describe("conciergeSuggestionText", () => {
  it("keeps an eligible named outcome without inventing extra details", () => {
    expect(conciergeSuggestionText({ name: "  Blue   Lagoon  " })).toBe("Blue Lagoon");
  });

  it.each([
    { name: "" },
    { name: "   " },
    { name: "Unknown" },
    { name: "x".repeat(241) },
  ])("refuses an outcome missing usable mandatory text: $name", (outcome) => {
    expect(conciergeSuggestionText(outcome)).toBeNull();
  });
});

describe("addConciergeOutcomeAsSuggestion", () => {
  it("creates an authenticated voteable suggestion proposal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));

    await addConciergeOutcomeAsSuggestion({
      slug: "example-coast",
      token: "private-token",
      outcome: { name: "Blue Lagoon" },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith("/api/trips/example-coast/suggestion-proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "private-token", text: "Blue Lagoon" }),
    });
  });

  it("surfaces the API failure and does not report success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(
      { error: "Suggestion could not be saved" },
      { status: 500 },
    ));

    await expect(addConciergeOutcomeAsSuggestion({
      slug: "example-coast",
      token: "private-token",
      outcome: { name: "Blue Lagoon" },
      fetchImpl,
    })).rejects.toThrow("Suggestion could not be saved");
  });

  it("does not call the API for an ineligible outcome", async () => {
    const fetchImpl = vi.fn();

    await expect(addConciergeOutcomeAsSuggestion({
      slug: "example-coast",
      token: "private-token",
      outcome: { name: "" },
      fetchImpl,
    })).rejects.toThrow("does not have enough detail");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
