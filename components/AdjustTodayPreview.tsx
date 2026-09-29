"use client";

import { useState } from "react";
import type { AdjustPreview } from "@/lib/adjust-today";

export type AdjustTodayPreviewData = AdjustPreview & {
  previewId: string | null;
  fingerprint: string;
  parsed: string[];
};

export default function AdjustTodayPreview({
  preview,
  busy,
  onAbandon,
  onApply,
}: {
  preview: AdjustTodayPreviewData;
  busy: boolean;
  onAbandon: () => void;
  onApply: () => void;
}) {
  const { impact } = preview;
  const [showUncertainty, setShowUncertainty] = useState(false);
  const hasConflicts = impact.conflicts.length > 0;
  const canApply = Boolean(preview.previewId) && preview.hasChanges && !hasConflicts;
  return (
    <section id="adjust-today-preview" className="mb-4 rounded-2xl border border-[#D9C49E] bg-[#FFF8EA] p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-[#C2571B]">Organizer review</p>
          <h2 className="mt-1 font-display text-xl font-semibold text-[#2D2A24]">Adjust today</h2>
          <p className="mt-1 text-sm text-[#756B5E]">“{preview.reason}” · no changes have been made.</p>
        </div>
        <button onClick={onAbandon} disabled={busy} aria-label="Abandon adjust today preview" className="rounded-full px-2 py-1 text-[#8A8272] hover:bg-[#EADFCC]">✕</button>
      </div>

      {preview.parsed.length > 0 && <p className="mt-3 text-xs text-[#5F7A54]">Understood: {preview.parsed.join(" · ")}</p>}
      {preview.impact.moves.length > 0 && <ImpactList title="Moves" items={preview.impact.moves.map((m) => `${m.venueName}: ${m.fromBlock} → ${m.toBlock}`)} />}
      {impact.skips.length > 0 && <ImpactList title="Removals (kept in history)" items={impact.skips.map((s) => `${s.venueName}: ${s.reason}`)} />}
      {impact.swaps.length > 0 && <ImpactList title="Replacements" items={impact.swaps.map((s) => `${s.fromVenueName} → ${s.toVenueName}: ${s.reason}`)} />}
      {impact.preserved.length > 0 && <ImpactList title="Protected / preserved" items={impact.preserved.map((p) => `${p.venueName}: ${p.reason}`)} tone="green" />}
      {impact.preferenceNotes.length > 0 && <ImpactList title="Preference and travel impact" items={impact.preferenceNotes} />}
      {impact.reservationNotes.length > 0 && <ImpactList title="Reservation impact" items={impact.reservationNotes} tone="green" />}
      {impact.unplaced.length > 0 && <ImpactList title="Could not place" items={impact.unplaced.map((u) => `${u.venueName}: ${u.reason}`)} tone="red" />}
      {impact.conflicts.map((conflict) => <p key={conflict} className="mt-2 rounded-xl bg-[#F9E4DE] px-3 py-2 text-sm text-[#9D3514]">⚠ {conflict}</p>)}
      {impact.uncertainties.length > 0 && (
        <div className="mt-3 rounded-xl border border-[#E5D39E] bg-white/60 p-3">
          <button onClick={() => setShowUncertainty((value) => !value)} className="text-sm font-semibold text-[#8A6D1F]">{showUncertainty ? "Hide" : "Show"} hours, traffic, and availability caveats</button>
          {showUncertainty && <ul className="mt-2 list-disc pl-5 text-xs text-[#756B5E]">{impact.uncertainties.map((item) => <li key={item}>{item}</li>)}</ul>}
        </div>
      )}
      {!preview.hasChanges && <p className="mt-3 text-sm text-[#5F7A54]">No safe changes fit these constraints.</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {canApply && <button onClick={onApply} disabled={busy} className="rounded-full bg-[#C2571B] px-5 py-2 font-semibold text-white hover:bg-[#A84A15] disabled:opacity-50">{busy ? "Applying…" : "Confirm and apply"}</button>}
        {hasConflicts && <p className="self-center text-xs text-[#9D3514]">Resolve the conflict and preview again.</p>}
        <button onClick={onAbandon} disabled={busy} className="rounded-full border border-[#EADFCC] px-4 py-2 text-sm font-semibold text-[#756B5E] hover:bg-white/70">Abandon</button>
      </div>
    </section>
  );
}

function ImpactList({ title, items, tone = "default" }: { title: string; items: string[]; tone?: "default" | "green" | "red" }) {
  const text = tone === "green" ? "text-[#46613D]" : tone === "red" ? "text-[#9D3514]" : "text-[#2D2A24]";
  return <div className="mt-3 rounded-xl bg-white/70 px-3 py-2"><p className="text-xs font-semibold uppercase tracking-widest text-[#8A8272]">{title}</p><ul className={`mt-1 list-disc pl-5 text-sm ${text}`}>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>;
}
