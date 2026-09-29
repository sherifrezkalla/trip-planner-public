"use client";
import { useState } from "react";
import { INTERESTS } from "@/lib/schema";

const INTEREST_LABELS: Record<string, string> = {
  food: "Food & markets", history: "History & museums", nature: "Nature & parks",
  nightlife: "Nightlife", shopping: "Shopping", art: "Art & culture",
  water: "Beaches & water", active: "Sports & active",
};

export default function JoinForm({ slug, onJoined }: { slug: string; onJoined: (token: string) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [interests, setInterests] = useState<string[]>([]);
  const [pace, setPace] = useState("balanced");
  const [dietary, setDietary] = useState("none");
  const [constraintsNote, setConstraintsNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function toggleInterest(i: string) {
    setInterests((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch(`/api/trips/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName, interests, pace, dietary, constraintsNote }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) return setError(body.error ?? "Could not join");
    localStorage.setItem(`tp:${slug}`, body.token);
    onJoined(body.token);
  }

  return (
    <form
      onSubmit={submit}
      className="mx-auto flex max-w-md flex-col gap-4 rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-8 shadow-sm"
    >
      <h1 className="font-display text-3xl font-semibold text-[#2D2A24]">Join this trip</h1>
      <input
        className="rounded-xl border border-[#EADFCC] bg-white/70 p-2 focus:border-[#C2571B] focus:outline-none focus:ring-2 focus:ring-[#C2571B]/40"
        placeholder="Your name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        required
      />
      <fieldset>
        <legend className="mb-2 font-semibold text-[#2D2A24]">What do you enjoy?</legend>
        <div className="flex flex-wrap gap-2">
          {INTERESTS.map((i) => {
            const active = interests.includes(i);
            return (
              <label
                key={i}
                className={`cursor-pointer rounded-full border px-3 py-1.5 text-sm transition ${
                  active
                    ? "border-[#C2571B] bg-[#C2571B] text-white"
                    : "border-[#EADFCC] bg-white/70 text-[#2D2A24] hover:bg-[#F3E0D3]"
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={active}
                  onChange={() => toggleInterest(i)}
                />
                {INTEREST_LABELS[i]}
              </label>
            );
          })}
        </div>
      </fieldset>
      <label className="text-sm text-[#2D2A24]">
        Pace
        <select
          className="w-full rounded-xl border border-[#EADFCC] bg-white/70 p-2 focus:border-[#C2571B] focus:outline-none focus:ring-2 focus:ring-[#C2571B]/40"
          value={pace}
          onChange={(e) => setPace(e.target.value)}
        >
          <option value="chill">Chill</option>
          <option value="balanced">Balanced</option>
          <option value="packed">Packed</option>
        </select>
      </label>
      <label className="text-sm text-[#2D2A24]">
        Dietary
        <select
          className="w-full rounded-xl border border-[#EADFCC] bg-white/70 p-2 focus:border-[#C2571B] focus:outline-none focus:ring-2 focus:ring-[#C2571B]/40"
          value={dietary}
          onChange={(e) => setDietary(e.target.value)}
        >
          <option value="none">No restrictions</option>
          <option value="vegetarian">Vegetarian</option>
          <option value="vegan">Vegan</option>
          <option value="halal">Halal</option>
          <option value="other">Other (mention below)</option>
        </select>
      </label>
      <textarea
        className="rounded-xl border border-[#EADFCC] bg-white/70 p-2 focus:border-[#C2571B] focus:outline-none focus:ring-2 focus:ring-[#C2571B]/40"
        placeholder="Anything else? (toddler, no early mornings, limited walking…)"
        value={constraintsNote}
        onChange={(e) => setConstraintsNote(e.target.value)}
      />
      {error && <p className="text-red-600">{error}</p>}
      <button
        className="rounded-full bg-[#C2571B] px-5 py-2.5 font-semibold text-white transition hover:bg-[#A84A15] disabled:opacity-50"
        disabled={busy || interests.length === 0}
      >
        {busy ? "Joining…" : "Join trip"}
      </button>
      {interests.length === 0 && <p className="text-sm text-[#8A8272]">Pick at least one interest.</p>}
    </form>
  );
}
