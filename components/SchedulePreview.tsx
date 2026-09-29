"use client";

export type PreviewMove = {
  itemId: string;
  venueName: string;
  fromDayIndex: number;
  fromBlock: string;
  toDayIndex: number;
  toBlock: string;
};

export type ReshufflePreview = {
  kind: "reshuffle";
  moves: PreviewMove[];
  unplaced: { itemId: string; venueName: string }[];
  conflicts: string[];
};

export type PartialDayPreview = {
  kind: "partial-day";
  trigger: "running-late";
  dayIndex: number;
  currentBlock: string;
  moves: PreviewMove[];
  skips: {
    itemId: string;
    venueName: string;
    fromDayIndex: number;
    fromBlock: string;
    reason: string;
  }[];
  preserved: {
    itemId: string;
    venueName: string;
    block: string;
    reason: "completed" | "skipped" | "locked";
  }[];
  conflicts: string[];
};

export type SchedulePreviewData = ReshufflePreview | PartialDayPreview;

export default function SchedulePreview({
  preview,
  busy,
  onClose,
  onApply,
}: {
  preview: SchedulePreviewData;
  busy: string;
  onClose: () => void;
  onApply: () => void;
}) {
  const isApplying = busy === "reshuffle-apply" || busy === "partial-day-apply";
  const hasChanges = preview.moves.length > 0
    || (preview.kind === "partial-day" && preview.skips.length > 0);
  const warnings = [
    ...preview.conflicts,
    ...(preview.kind === "reshuffle"
      ? preview.unplaced.map((item) => `${item.venueName} has no safe vacant slot yet`)
      : []),
  ];

  return (
    <section id="schedule-preview" className="mb-4 scroll-mt-4 rounded-2xl border border-[#D9C49E] bg-[#FFF8EA] p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-[#C2571B]">Review before applying</p>
          <h2 className="mt-1 font-display text-xl font-semibold text-[#2D2A24]">
            {preview.kind === "partial-day" ? "Today repair preview" : "Reshuffle preview"}
          </h2>
          <p className="mt-1 text-sm text-[#8A8272]">
            {preview.kind === "partial-day"
              ? "Compacts the flexible remainder of today. Completed, skipped, and locked activities stay untouched."
              : "Completed, skipped, and locked activities stay untouched."}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close schedule preview"
          className="rounded-full px-2 py-1 text-[#8A8272] hover:bg-[#EADFCC]"
        >
          ✕
        </button>
      </div>

      {preview.moves.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {preview.moves.map((move) => (
            <li key={move.itemId} className="rounded-xl bg-white/70 px-3 py-2 text-sm text-[#2D2A24]">
              <strong>{move.venueName}</strong>: Day {move.fromDayIndex + 1} {move.fromBlock}
              {" → "}Day {move.toDayIndex + 1} {move.toBlock}
            </li>
          ))}
        </ul>
      )}

      {preview.kind === "partial-day" && preview.skips.length > 0 && (
        <div className="mt-3 rounded-xl border border-[#E5D39E] bg-white/60 p-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-[#8A6D1F]">Set aside for today</p>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-[#5D554A]">
            {preview.skips.map((skip) => (
              <li key={skip.itemId}>
                <strong>{skip.venueName}</strong> stays in trip history as skipped.
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.kind === "partial-day" && preview.preserved.length > 0 && (
        <p className="mt-3 text-xs text-[#5F7A54]">
          ✓ {preview.preserved.length} protected {preview.preserved.length === 1 ? "activity" : "activities"} will not change.
        </p>
      )}

      {!hasChanges && (
        <p className="mt-3 text-sm text-[#5F7A54]">The remaining plan already fits around what is protected.</p>
      )}
      {warnings.map((warning) => (
        <p key={warning} className="mt-2 text-sm text-[#B0532F]">⚠ {warning}</p>
      ))}

      {hasChanges && (
        <button
          onClick={onApply}
          disabled={isApplying || preview.conflicts.length > 0}
          className="mt-4 rounded-full bg-[#C2571B] px-5 py-2 font-semibold text-white transition hover:bg-[#A84A15] disabled:opacity-50"
        >
          {isApplying
            ? "Applying…"
            : preview.kind === "partial-day" ? "Apply today's repair" : "Confirm reshuffle"}
        </button>
      )}
    </section>
  );
}
