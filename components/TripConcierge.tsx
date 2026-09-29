"use client";

import { useRef, useState } from "react";
import {
  addConciergeOutcomeAsSuggestion,
  conciergeSuggestionText,
} from "@/lib/concierge-outcomes";
import {
  formatOccurrenceDate,
  type ItineraryMatch,
  type ItineraryMatchStatus,
} from "@/lib/itinerary-finder";

type Place = {
  name: string;
  rating: number | null;
  reviewCount: number;
  mapsUrl: string;
  area: string;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  places?: Place[];
  itineraryMatches?: ItineraryMatch[];
};

const QUICK_QUESTIONS = [
  "Find a boat trip",
  "Recommend a restaurant",
  "What can we do tonight?",
];

const STATUS_LABEL: Record<ItineraryMatchStatus, string> = {
  planned: "Planned",
  done: "Done",
  skipped: "Removed",
};

/** Status chips read without colour, matching the trip board. */
function StatusBadge({ status }: { status: ItineraryMatchStatus }) {
  if (status === "planned") return null;
  return (
    <span className="rounded-full bg-[#E5DED2] px-2 py-0.5 text-xs font-semibold text-[#756B5E]">
      {STATUS_LABEL[status]}
    </span>
  );
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "The concierge could not answer right now.";
}

export default function TripConcierge({
  slug,
  token,
  promptRequest,
}: {
  slug: string;
  token: string;
  promptRequest?: { id: number; text: string } | null;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draftInput, setDraftInput] = useState("");
  const [consumedPromptId, setConsumedPromptId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [suggestionBusy, setSuggestionBusy] = useState("");
  const [suggested, setSuggested] = useState<Set<string>>(() => new Set());
  const [suggestionFeedback, setSuggestionFeedback] = useState<{
    text: string;
    kind: "success" | "error";
  } | null>(null);
  const suggestionInFlight = useRef(new Set<string>());
  const input = promptRequest && promptRequest.id !== consumedPromptId
    ? promptRequest.text
    : draftInput;

  async function ask(question: string) {
    const content = question.trim();
    if (!content || busy) return;
    const userMessage: Message = { role: "user", content };
    const nextMessages = [...messages, userMessage].slice(-12);
    setMessages(nextMessages);
    setDraftInput("");
    if (promptRequest) setConsumedPromptId(promptRequest.id);
    setBusy(true);
    setError("");

    try {
      const response = await fetch(`/api/trips/${slug}/concierge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          messages: nextMessages.map(({ role, content: text }) => ({ role, content: text })),
        }),
      });
      if (!response.ok) {
        setError(await responseError(response));
        return;
      }
      const body = (await response.json()) as {
        answer: string;
        places: Place[];
        itineraryMatches?: ItineraryMatch[];
      };
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: body.answer,
          places: body.places,
          itineraryMatches: body.itineraryMatches ?? [],
        },
      ]);
    } catch {
      setError("Could not reach the concierge. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function suggestPlace(place: Place, key: string) {
    if (suggestionInFlight.current.has(key) || suggested.has(key)) return;
    suggestionInFlight.current.add(key);
    setSuggestionBusy(key);
    setSuggestionFeedback(null);
    try {
      await addConciergeOutcomeAsSuggestion({ slug, token, outcome: place });
      setSuggested((current) => new Set(current).add(key));
      setSuggestionFeedback({
        text: `${place.name} was suggested to the group.`,
        kind: "success",
      });
    } catch (caught) {
      setSuggestionFeedback({
        text: caught instanceof Error ? caught.message : "Could not add this suggestion.",
        kind: "error",
      });
    } finally {
      suggestionInFlight.current.delete(key);
      setSuggestionBusy("");
    }
  }

  return (
    <section id="trip-concierge" className="mb-4 rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#F3E0D3] text-xl">
          💬
        </div>
        <div>
          <h2 className="font-display text-xl font-semibold text-[#2D2A24]">Ask the trip concierge</h2>
          <p className="mt-1 text-sm text-[#8A8272]">
            Find activities, restaurants, boat trips, or ideas around this trip.
          </p>
        </div>
      </div>

      {messages.length === 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {QUICK_QUESTIONS.map((question) => (
            <button
              key={question}
              onClick={() => ask(question)}
              disabled={busy}
              className="rounded-full border border-[#EADFCC] px-3 py-1.5 text-sm text-[#2D2A24] transition hover:bg-[#F3E0D3] disabled:opacity-50"
            >
              {question}
            </button>
          ))}
        </div>
      )}

      {messages.length > 0 && (
        <div className="mt-4 max-h-96 space-y-3 overflow-y-auto rounded-xl bg-[#F7F0E5] p-3">
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[90%] rounded-2xl px-3 py-2 text-sm ${
                  message.role === "user"
                    ? "bg-[#C2571B] text-white"
                    : "border border-[#EADFCC] bg-[#FFFDF8] text-[#2D2A24]"
                }`}
              >
                <p className="whitespace-pre-wrap">{message.content}</p>
                {message.itineraryMatches && message.itineraryMatches.length > 0 && (
                  <ul
                    aria-label="Matching itinerary stops"
                    className="mt-2 space-y-2 border-t border-[#EADFCC] pt-2"
                  >
                    {message.itineraryMatches.map((match) => {
                      const sameVenue = match.occurrences.length > 1;
                      const missingMaps = !match.mapsUrl;
                      return (
                        <li key={`${match.name}-${match.mapsUrl || match.area}`}>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            {missingMaps ? (
                              <span className="font-semibold">{match.name}</span>
                            ) : (
                              <a
                                href={match.mapsUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="font-semibold text-[#C2571B] hover:underline"
                                aria-label={`${match.name} in ${match.area}, open in Google Maps`}
                              >
                                {match.name} ↗
                              </a>
                            )}
                            <span className="text-xs text-[#8A8272]">
                              {match.area}
                              {match.categoryLabel ? ` · ${match.categoryLabel}` : ""}
                            </span>
                            {missingMaps && (
                              <span className="text-xs text-[#8A8272]">No Maps link stored</span>
                            )}
                          </div>
                          {sameVenue && (
                            <p className="mt-0.5 text-xs text-[#8A8272]">
                              Same venue appears {match.occurrences.length} times:
                            </p>
                          )}
                          <ul className="mt-0.5 space-y-0.5">
                            {match.occurrences.map((occurrence) => (
                              <li
                                key={`${occurrence.dayIndex}-${occurrence.block}-${occurrence.status}`}
                                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#2D2A24]"
                              >
                                <span>
                                  Day {occurrence.dayIndex + 1}
                                  {occurrence.date ? ` · ${formatOccurrenceDate(occurrence.date)}` : ""}
                                  {` · ${occurrence.block}`}
                                </span>
                                <StatusBadge status={occurrence.status} />
                              </li>
                            ))}
                          </ul>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {message.places && message.places.length > 0 && (
                  <ul className="mt-2 space-y-1.5 border-t border-[#EADFCC] pt-2">
                    {message.places.map((place) => {
                      const placeKey = `${index}:${place.name}:${place.mapsUrl}`;
                      const canSuggest = conciergeSuggestionText(place) !== null;
                      const isSaving = suggestionBusy === placeKey;
                      const isSuggested = suggested.has(placeKey);
                      return (
                        <li
                          key={`${place.name}-${place.mapsUrl}`}
                          className="flex flex-wrap items-center gap-x-2 gap-y-1"
                        >
                          <a
                            href={place.mapsUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="font-semibold text-[#C2571B] hover:underline"
                          >
                            {place.name} ↗
                          </a>
                          <span className="text-xs text-[#8A8272]">
                            {place.rating
                              ? `★ ${place.rating} (${place.reviewCount})`
                              : "unrated"}
                          </span>
                          {canSuggest && (
                            <button
                              type="button"
                              onClick={() => suggestPlace(place, placeKey)}
                              disabled={isSaving || isSuggested}
                              className="rounded-full border border-[#C2571B] px-2.5 py-1 text-xs font-semibold text-[#C2571B] transition hover:bg-[#F3E0D3] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {isSaving
                                ? "Suggesting…"
                                : isSuggested
                                  ? "Suggested to group"
                                  : "Suggest to group"}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          ))}
          {busy && <p className="text-sm text-[#8A8272]">Concierge is searching…</p>}
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          ask(input);
        }}
        className="mt-3 flex gap-2"
      >
        <input
          value={input}
          onChange={(event) => {
            if (promptRequest) setConsumedPromptId(promptRequest.id);
            setDraftInput(event.target.value);
          }}
          maxLength={2_000}
          placeholder="Ask about a place or activity…"
          aria-label="Ask the trip concierge"
          className="min-w-0 flex-1 rounded-xl border border-[#EADFCC] bg-white/70 px-3 py-2 text-[#2D2A24] outline-none placeholder:text-[#AAA18F] focus:border-[#C2571B]"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-full bg-[#C2571B] px-5 py-2 font-semibold text-white transition hover:bg-[#A84A15] disabled:opacity-50"
        >
          Ask
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {suggestionFeedback && (
        <p
          className={`mt-2 text-sm ${
            suggestionFeedback.kind === "success" ? "text-[#5F7A54]" : "text-red-600"
          }`}
          role={suggestionFeedback.kind === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {suggestionFeedback.text}
        </p>
      )}
      <p className="mt-2 text-xs text-[#8A8272]">
        Powered by DeepSeek V4 Flash · Check availability before booking.
      </p>
    </section>
  );
}
