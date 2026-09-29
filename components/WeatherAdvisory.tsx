"use client";

import { getTripDayDisplay } from "@/lib/today";

export type WeatherSwapPreview = {
  itemId: string;
  dayIndex: number;
  block: string;
  replacing: string;
  with: string;
  reason: string;
  beyondConfidentForecast: boolean;
};

export type WeatherScanResult = {
  swaps: WeatherSwapPreview[];
  proposalsRaised: number;
  unclassified: number;
};

type Props = {
  result: WeatherScanResult;
  startDate: string;
  busy: boolean;
  onRaise: () => void;
  onClose: () => void;
};

/**
 * What the forecast argues for, before anything is asked of the group.
 *
 * A scan previews by default and raises nothing until the organiser says so.
 * The reason travels with each swap because that is what the group votes on: a
 * substitution without "71% rain" attached is just someone changing the plan.
 */
export default function WeatherAdvisory({ result, startDate, busy, onRaise, onClose }: Props) {
  const raised = result.proposalsRaised > 0;

  return (
    <section className="mb-4 rounded-2xl border border-[#D9C49E] bg-[#FFF8EA] p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-[#C2571B]">
            Forecast check
          </p>
          <h3 className="mt-1 font-display text-lg text-[#2D2A24]">
            {result.swaps.length === 0
              ? "Nothing the weather argues against"
              : `${result.swaps.length} ${result.swaps.length === 1 ? "activity" : "activities"} the weather argues against`}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded-full border border-[#EADFCC] px-3 py-1 text-sm text-[#2D2A24] transition hover:bg-[#F3E0D3]"
        >
          Close
        </button>
      </div>

      {result.swaps.length === 0 && (
        <p className="mt-2 text-sm text-[#756B5E]">
          Every outdoor activity falls on a day the forecast can live with.
        </p>
      )}

      {result.swaps.length > 0 && (
        <ul className="mt-3 space-y-2">
          {result.swaps.map((swap) => {
            const day = getTripDayDisplay(startDate, swap.dayIndex);
            return (
              <li key={swap.itemId} className="rounded-xl border border-[#EADFCC] bg-white/70 p-3">
                <p className="text-xs font-semibold uppercase tracking-widest text-[#756B5E]">
                  {day.shortDate} · {swap.block}
                </p>
                <p className="mt-1 text-sm text-[#2D2A24]">
                  <span className="line-through opacity-60">{swap.replacing}</span>
                  {" → "}
                  <strong>{swap.with}</strong>
                </p>
                <p className="mt-0.5 text-sm text-[#756B5E]">{swap.reason}</p>
                {/* Forecast skill drops sharply past three days; saying so is
                    cheaper than a group acting on false confidence. */}
                {swap.beyondConfidentForecast && (
                  <p className="mt-1 text-xs text-[#8A6D1F]">
                    More than three days out — worth checking again nearer the day.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {result.unclassified > 0 && (
        <p className="mt-3 text-xs text-[#8A8272]">
          {result.unclassified} venues not yet checked for shelter. Run this again to cover them —
          nothing already checked is redone.
        </p>
      )}

      {result.swaps.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={onRaise}
            disabled={busy || raised}
            className="rounded-full bg-[#C2571B] px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-[#A84A15] disabled:opacity-50"
          >
            {raised
              ? `${result.proposalsRaised} sent to the group`
              : busy
                ? "Asking the group…"
                : `Ask the group about ${result.swaps.length === 1 ? "this" : "these"}`}
          </button>
          {!raised && (
            <span className="text-xs text-[#8A8272]">
              Raises a request each. Nothing changes until the group agrees.
            </span>
          )}
        </div>
      )}
    </section>
  );
}
