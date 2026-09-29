"use client";

import { useEffect, useState } from "react";
import {
  freshnessLabel,
  getTripDayDisplay,
  getTripTiming,
  itemsForToday,
  leaveByEstimate,
  nextTodayItem,
  openingHoursForToday,
  type TodayItem,
  venueHoursRisk,
} from "@/lib/today";
import type { TodayWeather } from "@/lib/weather";
import { ReservationSummary } from "@/components/ReservationDetails";

type TodayBoardItem = TodayItem & {
  durationMin: number;
  area: string;
  isLocked: boolean;
  travelWarning: boolean;
  venue: TodayItem["venue"] & { name: string; mapsUrl: string; fetchedAt: string };
};

type Props = {
  trip: {
    destinationName: string;
    startDate: string;
    endDate: string;
    dayCount: number;
    lat: number;
    lng: number;
  };
  items: TodayBoardItem[];
  isOrganizer: boolean;
  busy: string;
  onSelectDay: (dayIndex: number) => void;
  onUpdateActivity: (itemId: string, status: "done" | "skipped") => void;
  onPreviewReshuffle: () => void;
  onPreviewPartialDay: () => void;
  onAdjustToday: (reason: string) => void;
  adjustTodayBusy: boolean;
  onAskConcierge: (prompt: string) => void;
};

type WeatherState =
  | { status: "loading" }
  | { status: "ready"; data: TodayWeather }
  | { status: "error" };

const HELP_OPTIONS = [
  {
    label: "Running late",
    icon: "⏱",
    prompt: "We are running late today. Help us simplify the rest of today's plan while keeping any booked or locked activities.",
  },
  {
    label: "Rain plan",
    icon: "☔",
    prompt: "We need a rain-friendly alternative for the rest of today. Consider our itinerary and group preferences.",
  },
  {
    label: "Lower energy",
    icon: "🌿",
    prompt: "The group has lower energy today. Suggest an easier version of the rest of today's plan nearby.",
  },
  {
    label: "Nearby option",
    icon: "📍",
    prompt: "Find a good nearby alternative for our next activity today that suits the group.",
  },
] as const;

export default function TodayMode({
  trip,
  items,
  isOrganizer,
  busy,
  onSelectDay,
  onUpdateActivity,
  onPreviewReshuffle,
  onPreviewPartialDay,
  onAdjustToday,
  adjustTodayBusy,
  onAskConcierge,
}: Props) {
  const now = new Date();
  const timing = getTripTiming(trip.startDate, trip.endDate, now);
  const [weather, setWeather] = useState<WeatherState>({ status: "loading" });

  useEffect(() => {
    if (timing.phase !== "during") return;
    const controller = new AbortController();
    let active = true;
    const loadWeather = async () => {
      try {
        const response = await fetch(
          `/api/weather?lat=${encodeURIComponent(trip.lat)}&lng=${encodeURIComponent(trip.lng)}`,
          { signal: controller.signal },
        );
        const body = response.ok ? await response.json() as { weather?: TodayWeather } : null;
        if (active) setWeather(body?.weather ? { status: "ready", data: body.weather } : { status: "error" });
      } catch {
        if (active && !controller.signal.aborted) setWeather({ status: "error" });
      }
    };
    void loadWeather();
    const refresh = window.setInterval(() => void loadWeather(), 15 * 60_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(refresh);
    };
  }, [timing.phase, trip.lat, trip.lng]);

  if (timing.phase === "before") {
    return (
      <section className="mb-4 rounded-2xl border border-[#D9C49E] bg-[#FFF8EA] p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-widest text-[#C2571B]">Today Mode</p>
        <h2 className="mt-1 font-display text-2xl font-semibold text-[#2D2A24]">
          {timing.daysUntilStart === 1 ? "Your trip starts tomorrow" : `${timing.daysUntilStart} days to go`}
        </h2>
        <p className="mt-1 text-sm text-[#8A8272]">
          On Day 1 this becomes your live view of what is next, what is done, and what needs adapting.
        </p>
      </section>
    );
  }

  if (timing.phase === "after") {
    const completed = items.filter((item) => item.status === "done").length;
    return (
      <section className="mb-4 rounded-2xl border border-[#C9D8BF] bg-[#F4F8F1] p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-widest text-[#5F7A54]">Trip complete</p>
        <h2 className="mt-1 font-display text-2xl font-semibold text-[#2D2A24]">
          {completed} {completed === 1 ? "activity" : "activities"} completed
        </h2>
        <button
          onClick={() => onSelectDay(timing.dayIndex)}
          className="mt-3 rounded-full border border-[#C9D8BF] px-4 py-2 text-sm font-semibold text-[#46613D] transition hover:bg-white/70"
        >
          View the final day
        </button>
      </section>
    );
  }

  const todayItems = itemsForToday(items, timing.dayIndex) as TodayBoardItem[];
  const next = nextTodayItem(items, timing.dayIndex, now) as TodayBoardItem | null;
  const done = todayItems.filter((item) => item.status === "done").length;
  const skipped = todayItems.filter((item) => item.status === "skipped").length;
  const settled = done + skipped;
  const progress = todayItems.length ? Math.round((settled / todayItems.length) * 100) : 0;
  const hasProgress = items.some((item) => item.status !== "planned" || item.isLocked);
  const hours = next ? openingHoursForToday(next.venue.openingHours, now) : null;
  const hoursRisk = next
    ? venueHoursRisk(next.venue.openingPeriods, trip.startDate, timing.dayIndex, next.block, next.durationMin, now)
    : null;
  const leaveBy = next ? leaveByEstimate(items, next, timing.dayIndex, trip.startDate, now) : null;

  const hoursRiskStyle = hoursRisk?.level === "danger" ? "border-[#E8B4A2] bg-[#FFF1EC] text-[#9D3514]"
    : hoursRisk?.level === "warning" ? "border-[#E5D39E] bg-[#FFF9E8] text-[#7D6418]"
      : hoursRisk?.level === "clear" ? "border-[#C9D8BF] bg-[#F4F8F1] text-[#46613D]"
        : "border-[#EADFCC] bg-[#F7F0E5] text-[#756B5E]";

  return (
    <section className="mb-4 overflow-hidden rounded-2xl border border-[#D9C49E] bg-[#FFF8EA] shadow-sm">
      <div className="bg-[#C2571B] px-4 py-4 text-white sm:px-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/75">Today Mode</p>
            <h2 className="mt-1 font-display text-2xl font-semibold">Day {timing.dayIndex + 1} of {trip.dayCount}</h2>
            <p className="mt-0.5 text-sm text-white/85">{getTripDayDisplay(trip.startDate, timing.dayIndex).fullDate}</p>
          </div>
          <span className="rounded-full bg-white/15 px-3 py-1 text-sm font-semibold">{progress}% settled</span>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/20" aria-label={`${progress}% of today's plan settled`}>
          <div className="h-full rounded-full bg-white transition-all" style={{ width: `${progress}%` }} />
        </div>
        <p className="mt-2 text-xs text-white/75">{done} done · {skipped} skipped · {todayItems.length - settled} remaining</p>
      </div>

      <div className="p-4 sm:p-5">
        <div className="mb-4 grid gap-2 sm:grid-cols-2">
          <div className={`rounded-xl border p-3 ${
            weather.status === "ready" && weather.data.risk === "warning"
              ? "border-[#E8B4A2] bg-[#FFF1EC]"
              : weather.status === "ready" && weather.data.risk === "watch"
                ? "border-[#E5D39E] bg-[#FFF9E8]"
                : "border-[#C9D8BF] bg-[#F4F8F1]"
          }`}>
            <p className="text-xs font-semibold uppercase tracking-widest text-[#756B5E]">Live weather</p>
            {weather.status === "loading" && <p className="mt-1 text-sm text-[#8A8272]">Checking today&apos;s forecast…</p>}
            {weather.status === "error" && (
              <p className="mt-1 text-sm text-[#8A6D1F]">Weather unavailable — check a local forecast before adapting.</p>
            )}
            {weather.status === "ready" && (
              <>
                <p className="mt-1 font-semibold text-[#2D2A24]">
                  {weather.data.temperatureC}°C · {weather.data.summary}
                </p>
                <p className="mt-0.5 text-sm text-[#756B5E]">{weather.data.riskMessage}</p>
                <p className="mt-1 text-xs text-[#8A8272]">
                  Open-Meteo · retrieved {new Date(weather.data.fetchedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })} · refreshes every 15 min
                </p>
              </>
            )}
          </div>

          <div className={`rounded-xl border p-3 ${hoursRiskStyle}`}>
            <p className="text-xs font-semibold uppercase tracking-widest">Next venue check</p>
            <p className="mt-1 text-sm font-semibold">{hoursRisk?.message ?? "No next venue to check"}</p>
            <p className="mt-1 text-xs opacity-75">
              Regular Google hours · {next ? freshnessLabel(next.venue.fetchedAt, now) : "no venue data"}. Holidays may differ.
            </p>
          </div>
        </div>

        {next ? (
          <div className="rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-4">
            <p className="text-xs font-semibold uppercase tracking-widest text-[#C2571B]">Next up · {next.block}</p>
            <div className="mt-1 flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div className="min-w-0">
                <h3 className="font-display text-xl font-semibold text-[#2D2A24]">{next.venue.name}</h3>
                <p className="text-sm text-[#8A8272]">
                  {next.area || trip.destinationName} · about {next.durationMin} min
                  {next.isLocked ? " · 🔒 locked" : ""}
                </p>
                {hours && <p className="mt-1 text-sm text-[#5F7A54]">Today&apos;s listed hours: {hours.replace(/^[^:]+:\s*/, "")}</p>}
                {next.travelWarning && <p className="mt-1 text-sm text-[#8A6D1F]">⚠ Longer transfer from the previous stop</p>}
                {leaveBy && (
                  <div className={`mt-2 rounded-xl px-3 py-2 text-sm ${
                    leaveBy.urgency === "late" || leaveBy.urgency === "now"
                      ? "bg-[#FFF1EC] text-[#9D3514]"
                      : leaveBy.urgency === "soon"
                        ? "bg-[#FFF9E8] text-[#7D6418]"
                        : "bg-[#F4F8F1] text-[#46613D]"
                  }`}>
                    <strong>
                      {leaveBy.urgency === "late" ? "Planned start has passed"
                        : leaveBy.urgency === "now" ? "Leave now"
                          : `Leave by ${leaveBy.leaveBy.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                    </strong>
                    <span>
                      {` · about ${leaveBy.transfer.durationMin} min ${leaveBy.transfer.mode} from ${leaveBy.originName}`}
                    </span>
                    <p className="mt-0.5 text-xs opacity-75">Planning estimate from distance; open Maps for live routing and traffic.</p>
                  </div>
                )}
                {next.reservation && <ReservationSummary reservation={next.reservation} compact />}
              </div>
              <a
                href={next.venue.mapsUrl}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded-full border border-[#EADFCC] px-4 py-2 text-center text-sm font-semibold text-[#2D2A24] transition hover:bg-[#F3E0D3]"
              >
                Open in Maps ↗
              </a>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={() => onUpdateActivity(next.id, "done")}
                disabled={busy === `state:${next.id}`}
                className="rounded-full bg-[#5F7A54] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#4C6544] disabled:opacity-50"
              >
                ✓ We did this
              </button>
              <button
                onClick={() => onUpdateActivity(next.id, "skipped")}
                disabled={busy === `state:${next.id}`}
                className="rounded-full border border-[#EADFCC] px-4 py-2 text-sm font-semibold text-[#756B5E] transition hover:bg-[#F3E0D3] disabled:opacity-50"
              >
                Skip
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-[#C9D8BF] bg-[#F4F8F1] p-4">
            <h3 className="font-display text-xl font-semibold text-[#46613D]">
              {todayItems.length ? "Today is settled" : "Nothing is scheduled today"}
            </h3>
            <p className="mt-1 text-sm text-[#5F7A54]">Ask the concierge for a nearby idea, or enjoy the open time.</p>
          </div>
        )}

        {isOrganizer && <div className="mt-4 rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-4">
          <p className="mt-1 text-xs text-[#8A8272]">Describe a pace, activity, duration, accessibility, or must-keep constraint. This only opens a preview; the itinerary changes after confirmation.</p>
          <form className="mt-2 flex flex-col gap-2 sm:flex-row" onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const input = form.elements.namedItem("adjust-reason") as HTMLInputElement;
            if (input.value.trim()) onAdjustToday(input.value.trim());
          }}>
            <input name="adjust-reason" maxLength={240} required placeholder="e.g. Low energy, keep the museum, shorter accessible activities" aria-label="Adjust today constraint" className="min-w-0 flex-1 rounded-xl border border-[#EADFCC] bg-white px-3 py-2 text-sm text-[#2D2A24] outline-none focus:border-[#C2571B]" />
            <button type="submit" disabled={adjustTodayBusy} className="rounded-full bg-[#C2571B] px-4 py-2 text-sm font-semibold text-white hover:bg-[#A84A15] disabled:opacity-50">{adjustTodayBusy ? "Planning…" : "Preview adjust"}</button>
          </form>
        </div>}

        <div className="mt-4">
          <h3 className="text-sm font-semibold text-[#2D2A24]">Need to adapt?</h3>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {HELP_OPTIONS.map((option) => (
              <button
                key={option.label}
                onClick={() => option.label === "Running late" && isOrganizer
                  ? onPreviewPartialDay()
                  : onAskConcierge(`${option.prompt} This is Day ${timing.dayIndex + 1} in ${trip.destinationName}.`)}
                disabled={option.label === "Running late" && [
                  "partial-day-preview", "partial-day-apply", "reshuffle-preview", "reshuffle-apply",
                ].includes(busy)}
                className="rounded-xl border border-[#EADFCC] bg-[#FFFDF8] px-3 py-2 text-left text-sm text-[#2D2A24] transition hover:border-[#C2571B] hover:bg-white disabled:opacity-50"
              >
                <span className="mr-1" aria-hidden="true">{option.icon}</span>{" "}
                {option.label === "Running late" && busy === "partial-day-preview" ? "Planning…" : option.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-[#8A8272]">
            Running late gives the organizer a reviewable repair; every change still needs confirmation.
            Other options prepare concierge advice only.
          </p>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 border-t border-[#EADFCC] pt-4">
          <button
            onClick={() => onSelectDay(timing.dayIndex)}
            className="rounded-full border border-[#EADFCC] px-4 py-2 text-sm font-semibold text-[#2D2A24] transition hover:bg-[#F3E0D3]"
          >
            View today&apos;s full plan
          </button>
          {isOrganizer && hasProgress && (
            <button
              onClick={onPreviewReshuffle}
              disabled={[
                "reshuffle-preview", "reshuffle-apply", "partial-day-preview", "partial-day-apply",
              ].includes(busy)}
              className="rounded-full bg-[#C2571B] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#A84A15] disabled:opacity-50"
            >
              {busy === "reshuffle-preview" ? "Planning…" : "Preview smart reshuffle"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
