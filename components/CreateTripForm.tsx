"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Suggestion = { placeId: string; name: string; address: string; lat: number; lng: number };

export default function CreateTripForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [budgetLevel, setBudgetLevel] = useState<"low" | "mid" | "high">("mid");
  const [exploreRadiusKm, setExploreRadiusKm] = useState<15 | 60 | 100>(15);
  const [vibeNote, setVibeNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /**
   * One lookup per pause in typing, not one per keystroke.
   *
   * Every suggestion list is a billed Google Places call, so "Barcelona" should
   * cost one lookup rather than the eight it used to. The in-flight request is
   * abandoned when the query moves on, so a slow answer cannot arrive after a
   * newer one and repopulate the list with stale suggestions.
   */
  useEffect(() => {
    const q = query.trim();
    // Clearing for a too-short query happens in the change handler, where it is
    // a direct consequence of the keystroke rather than an effect of it.
    if (q.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/places/autocomplete?q=${encodeURIComponent(q)}`,
          { signal: controller.signal },
        );
        if (res.status === 429) {
          setSuggestions([]);
          setError("Too many destination searches. Wait a moment and try again.");
          return;
        }
        if (res.ok) {
          setError("");
          setSuggestions((await res.json()).results);
        }
      } catch {
        // Abandoned or offline. The field stays usable; the next keystroke retries.
      }
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return setError("Pick a destination from the suggestions");
    setBusy(true);
    setError("");
    const res = await fetch("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        destinationName: selected.name,
        destinationPlaceId: selected.placeId,
        lat: selected.lat,
        lng: selected.lng,
        startDate,
        endDate,
        budgetLevel,
        exploreRadiusKm,
        vibeNote,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      setBusy(false);
      return setError(body.error ?? "Something went wrong");
    }
    router.push(`/t/${body.slug}`);
  }

  return (
    <form
      onSubmit={submit}
      className="mx-auto flex max-w-md flex-col gap-4 rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-8 shadow-sm"
    >
      <h1 className="font-display text-3xl font-semibold text-[#2D2A24]">Plan a trip together</h1>
      <input
        className="rounded-xl border border-[#EADFCC] bg-white/70 p-2 text-[#2D2A24] focus:border-[#C2571B] focus:outline-none focus:ring-2 focus:ring-[#C2571B]/40"
        placeholder="Trip name (optional) — e.g. Albanien 2026"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={80}
      />
      <div className="relative">
        <input
          className="w-full rounded-xl border border-[#EADFCC] bg-white/70 p-2 focus:border-[#C2571B] focus:outline-none focus:ring-2 focus:ring-[#C2571B]/40"
          placeholder="Where are you going?"
          value={selected ? selected.name : query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(null);
            if (e.target.value.trim().length < 2) setSuggestions([]);
          }}
          required
        />
        {suggestions.length > 0 && !selected && (
          <ul className="absolute z-10 w-full rounded-xl border border-[#EADFCC] bg-white shadow-md">
            {suggestions.map((s) => (
              <li key={s.placeId}>
                <button
                  type="button"
                  className="block w-full p-2 text-left hover:bg-[#F3E0D3]"
                  onClick={() => {
                    setSelected(s);
                    setSuggestions([]);
                  }}
                >
                  {s.name} <span className="text-sm text-[#8A8272]">{s.address}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex gap-2">
        <label className="flex-1 text-sm text-[#2D2A24]">
          From
          <input
            type="date"
            className="w-full rounded-xl border border-[#EADFCC] bg-white/70 p-2 focus:border-[#C2571B] focus:outline-none focus:ring-2 focus:ring-[#C2571B]/40"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            required
          />
        </label>
        <label className="flex-1 text-sm text-[#2D2A24]">
          To
          <input
            type="date"
            className="w-full rounded-xl border border-[#EADFCC] bg-white/70 p-2 focus:border-[#C2571B] focus:outline-none focus:ring-2 focus:ring-[#C2571B]/40"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            required
          />
        </label>
      </div>
      <label className="text-sm text-[#2D2A24]">
        Budget
        <select
          className="w-full rounded-xl border border-[#EADFCC] bg-white/70 p-2 focus:border-[#C2571B] focus:outline-none focus:ring-2 focus:ring-[#C2571B]/40"
          value={budgetLevel}
          onChange={(e) => setBudgetLevel(e.target.value as "low" | "mid" | "high")}
        >
          <option value="low">€ — keep it cheap</option>
          <option value="mid">€€ — comfortable</option>
          <option value="high">€€€ — treat ourselves</option>
        </select>
      </label>
      <label className="text-sm text-[#2D2A24]">
        How far will you roam?
        <select
          className="w-full rounded-xl border border-[#EADFCC] bg-white/70 p-2 focus:border-[#C2571B] focus:outline-none focus:ring-2 focus:ring-[#C2571B]/40"
          value={exploreRadiusKm}
          onChange={(e) => setExploreRadiusKm(Number(e.target.value) as 15 | 60 | 100)}
        >
          <option value={15}>Just the city</option>
          <option value={60}>Day trips — about 1½ hours&apos; drive</option>
          <option value={100}>Wide region — long days out</option>
        </select>
      </label>
      <label className="text-sm text-[#2D2A24]">
        Trip vibe (optional)
        <textarea
          className="w-full rounded-xl border border-[#EADFCC] bg-white/70 p-2 focus:border-[#C2571B] focus:outline-none focus:ring-2 focus:ring-[#C2571B]/40"
          value={vibeNote}
          onChange={(e) => setVibeNote(e.target.value)}
          placeholder="e.g. relaxed foodie trip, no early mornings"
        />
      </label>
      {error && <p className="text-red-600">{error}</p>}
      <button
        className="rounded-full bg-[#C2571B] px-5 py-2.5 font-semibold text-white transition hover:bg-[#A84A15] disabled:opacity-50"
        disabled={busy}
      >
        {busy ? "Creating…" : "Create trip"}
      </button>
    </form>
  );
}
