"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { browserClient } from "@/lib/supabase-browser";
import JoinForm from "@/components/JoinForm";
import DayMap from "@/components/DayMap";
import TripConcierge from "@/components/TripConcierge";
import TodayMode from "@/components/TodayMode";
import SchedulePreview, { type SchedulePreviewData } from "@/components/SchedulePreview";
import AdjustTodayPreview, { type AdjustTodayPreviewData } from "@/components/AdjustTodayPreview";
import WeatherAdvisory, { type WeatherScanResult } from "@/components/WeatherAdvisory";
import {
  ActivityPreferenceFit,
  PreferenceCoverageSummary,
} from "@/components/PreferenceCoverage";
import { canManageSchedule, canSwap } from "@/lib/permissions";
import { analyzePreferenceCoverage } from "@/lib/preference-coverage";
import { TRIP_TOKEN_HEADER } from "@/lib/auth";
import { buildResumeUrl } from "@/lib/resume";
import { currentTodayBlock, getTripDayDisplay, getTripTiming } from "@/lib/today";
import { attendanceForDay } from "@/lib/attendance";
import type { OpeningPeriod } from "@/lib/places";
import ReservationDetails from "@/components/ReservationDetails";
import PendingRequests, { type PendingProposal } from "@/components/PendingRequests";
import type { ReservationDetails as Reservation } from "@/lib/reservations";
import {
  isOrganizerReservationAttempt,
  type ReservationAttempt,
  type ReservationAttemptSummary,
} from "@/lib/reservation-assistance";
import ReservationAssistance from "@/components/ReservationAssistance";
import AgentConnectionSetup from "@/components/AgentConnectionSetup";

type Venue = {
  name: string; rating: number | null; reviewCount: number; priceLevel: string | null;
  openingHours: string[]; openingPeriods: OpeningPeriod[];
  categories: string[];
  lat: number; lng: number; mapsUrl: string; fetchedAt: string;
};
type BoardItem = {
  id: string; dayIndex: number; block: string; whyNote: string; durationMin: number;
  position: number; travelWarning: boolean; venue: Venue; voteSum: number; myVote: number;
  status: "planned" | "done" | "skipped"; isLocked: boolean;
  completedAt: string | null; completedDayIndex: number | null;
  stateChangedByName: string | null;
  reservation: Reservation;
  reservationAttempt: ReservationAttempt | ReservationAttemptSummary | null;
  /** Town or area this day is anchored to; empty on city trips. */
  area: string;
};
type Board = {
  trip: { slug: string; title: string; destinationName: string; startDate: string; endDate: string; dayCount: number; lat: number; lng: number };
  me: { id: string; isOrganizer: boolean };
  travelers: {
    id: string; displayName: string; isOrganizer: boolean; isBot: boolean;
    interests: string[]; pace: string; dietary: string;
    constraintsNote: string; joinedAt: string; voteCount: number;
    arrivesOn: string | null; departsOn: string | null;
  }[];
  suggestions: {
    id: string; text: string; travelerId: string; displayName: string;
    createdAt: string; canDelete: boolean;
  }[];
  items: BoardItem[];
  proposals: PendingProposal[];
  latestAdjustTodayRevision: {
    id: string; dayIndex: number; reason: string; changes: unknown; actorId: string | null; actorName: string; createdAt: string;
  } | null;
};

const BLOCK_ORDER = ["morning", "lunch", "afternoon", "dinner", "evening"];

function hasPlannedReplacement(items: BoardItem[], historical: BoardItem): boolean {
  return items.some((item) =>
    item.id !== historical.id
    && item.status === "planned"
    && item.dayIndex === historical.dayIndex
    && item.block === historical.block,
  );
}

/** Failing responses aren't always JSON — a gateway timeout returns HTML. */
async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "";
}

export default function TripBoard({ slug }: { slug: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [day, setDay] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  /**
   * Generation failures are kept apart from the shared error line, which renders
   * at the foot of the board past the whole itinerary. Generation can now fail
   * outright — there is no longer a mechanical plan substituted behind the
   * group's back — so the reason has to appear next to the button that was
   * pressed, on an empty board and on a regeneration alike.
   */
  const [generateError, setGenerateError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [ready, setReady] = useState(false);
  const [showResume, setShowResume] = useState(false);
  const [showRoster, setShowRoster] = useState(false);
  const [copied, setCopied] = useState(false);
  const [suggestionText, setSuggestionText] = useState("");
  const [suggestionBusy, setSuggestionBusy] = useState("");
  const [schedulePreview, setSchedulePreview] = useState<SchedulePreviewData | null>(null);
  const [adjustTodayPreview, setAdjustTodayPreview] = useState<AdjustTodayPreviewData | null>(null);
  const [weatherScan, setWeatherScan] = useState<WeatherScanResult | null>(null);
  const [conciergePrompt, setConciergePrompt] = useState<{ id: number; text: string } | null>(null);
  const [movingItemId, setMovingItemId] = useState("");
  const [moveTarget, setMoveTarget] = useState<{ dayIndex: number; block: string } | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [alerts, setAlerts] = useState<{ linked: boolean; available: boolean } | null>(null);

  // An assistant's stated interests are not a person's preferences, so they
  // neither earn coverage nor drag the group's balance down.
  const preferenceCoverage = useMemo(() => board ? analyzePreferenceCoverage({
    travelers: board.travelers.filter((t) => !t.isBot),
    items: board.items.map((item) => ({
      id: item.id,
      dayIndex: item.dayIndex,
      status: item.status,
      categories: item.venue.categories,
    })),
  }) : null, [board]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setDay(null);
      setToken(localStorage.getItem(`tp:${slug}`));
      setReady(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [slug]);

  const refetch = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`/api/trips/${slug}`, {
        headers: { [TRIP_TOKEN_HEADER]: token },
      });
      if (res.status === 401) {
        localStorage.removeItem(`tp:${slug}`);
        setToken(null);
        return;
      }
      if (res.ok) {
        const nextBoard = await res.json() as Board;
        setBoard(nextBoard);
        setLoadError("");
        return;
      }
      // Anything else (trip gone, database asleep, gateway timeout) must surface —
      // silently ignoring it leaves the page spinning forever.
      setLoadError(
        res.status === 404
          ? "This trip link doesn't exist any more."
          : (await readError(res)) || `Couldn't load this trip (error ${res.status}).`,
      );
    } catch {
      setLoadError("Couldn't reach the server. Check your connection and try again.");
    }
  }, [slug, token]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => void refetch());
    return () => cancelAnimationFrame(frame);
  }, [refetch]);

  // Kept off the board payload: every traveller would carry it, and only the
  // organiser can act on it.
  useEffect(() => {
    if (!token || !board?.me.isOrganizer) return;
    let cancelled = false;
    void fetch(`/api/trips/${slug}/telegram/link`, {
      headers: { [TRIP_TOKEN_HEADER]: token },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setAlerts(data as { linked: boolean; available: boolean });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug, token, board?.me.isOrganizer]);

  useEffect(() => {
    if (!token) return;
    const channel = browserClient()
      .channel(`trip:${slug}`)
      .on("broadcast", { event: "updated" }, () => refetch())
      .subscribe();
    return () => {
      channel.unsubscribe();
    };
  }, [slug, token, refetch]);

  async function generate() {
    // A plan built before anyone else joins is tuned to one person's preferences.
    if (
      board &&
      board.travelers.length < 2 &&
      !confirm(
        "Only you have joined so far, so the plan will reflect your preferences alone.\n\nGenerate anyway?",
      )
    ) {
      return;
    }
    setBusy("generate");
    setError("");
    setGenerateError("");
    try {
      // The server caches venues first and answers `stage: "venues"`; the second
      // call builds the plan against that cache with a full time budget.
      for (let call = 0; call < 2; call++) {
        const res = await fetch(`/api/trips/${slug}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) {
          setGenerateError((await readError(res)) || "Generation failed — please try again.");
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { stage?: string };
        if (body.stage === "venues") {
          setBusy("venues");
          continue;
        }
        await refetch();
        return;
      }
    } catch {
      setGenerateError("Generation was interrupted. Venues are saved, so trying again is quicker.");
    } finally {
      setBusy("");
    }
  }

  async function vote(itemId: string, value: 1 | -1) {
    await fetch(`/api/items/${itemId}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, token, value }),
    });
    refetch();
  }

  async function rename() {
    if (!board) return;
    const next = prompt("Name this trip", board.trip.title || board.trip.destinationName);
    if (next === null) return;
    setError("");
    const res = await fetch(`/api/trips/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, title: next.trim() }),
    });
    if (!res.ok) setError((await readError(res)) || "Could not rename the trip.");
    else refetch();
  }

  async function removeTraveler(travelerId: string, name: string) {
    if (!confirm(`Remove ${name} from this trip? Their votes go with them.`)) return;
    setError("");
    const res = await fetch(`/api/trips/${slug}/travelers/${travelerId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) setError((await readError(res)) || "Could not remove that traveller.");
    else refetch();
  }

  async function swap(itemId: string) {
    setBusy(itemId);
    setError("");
    const res = await fetch(`/api/items/${itemId}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, token }),
    });
    setBusy("");
    if (!res.ok) setError((await readError(res)) || "Swap failed — please try again.");
    else refetch();
  }

  async function updateActivity(
    item: BoardItem,
    change:
      | { action: "status"; status: "planned" | "done" | "skipped" }
      | { action: "lock"; isLocked: boolean },
  ) {
    if (
      change.action === "status" && change.status === "skipped" &&
      !confirm(`Remove ${item.venue.name} from the plan? It stays in the trip history and you can put it back.`)
    ) return;
    setBusy(`state:${item.id}`);
    setError("");
    setSchedulePreview(null);
    try {
      const payload = change.action === "status"
        ? {
            ...change,
            slug,
            token,
            completedDayIndex: change.status === "done" && board
              ? getTripTiming(board.trip.startDate, board.trip.endDate).dayIndex
              : undefined,
          }
        : { ...change, slug, token };
      const res = await fetch(`/api/items/${item.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) setError((await readError(res)) || "Could not update that activity.");
      else await refetch();
    } catch {
      setError("Could not update that activity. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  }

  async function moveActivity(item: BoardItem, toDayIndex: number, toBlock: string) {
    setBusy(`move:${item.id}`);
    setError("");
    setSchedulePreview(null);
    try {
      const res = await fetch(`/api/items/${item.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          token,
          fromDayIndex: item.dayIndex,
          fromBlock: item.block,
          toDayIndex,
          toBlock,
        }),
      });
      if (!res.ok) {
        setError((await readError(res)) || "Could not move that activity.");
      } else {
        setMovingItemId("");
        setMoveTarget(null);
        await refetch();
      }
    } catch {
      setError("Could not move that activity. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  }

  async function linkTelegram() {
    setBusy("telegram");
    setError("");
    try {
      const res = await fetch(`/api/trips/${slug}/telegram/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !body?.url) {
        setError(body?.error || "Could not start Telegram linking.");
        return;
      }
      // Opened rather than navigated: losing the board to switch apps, on a
      // phone, mid-trip, is a worse trade than a second tab.
      window.open(body.url, "_blank", "noopener,noreferrer");
    } catch {
      setError("Could not start Telegram linking. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  }

  async function proposeChange(
    item: BoardItem,
    change: { kind: "move"; toDayIndex: number; toBlock: string } | { kind: "remove" },
  ) {
    const note = prompt(
      change.kind === "remove"
        ? `Ask the group to drop ${item.venue.name}. Why? (optional)`
        : `Ask the group to move ${item.venue.name}. Why? (optional)`,
      "",
    );
    if (note === null) return;

    setBusy(`propose:${item.id}`);
    setError("");
    try {
      const res = await fetch(`/api/items/${item.id}/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, token, note: note.trim().slice(0, 200), ...change }),
      });
      if (!res.ok) {
        setError((await readError(res)) || "Could not send that request.");
      } else {
        setMovingItemId("");
        setMoveTarget(null);
        await refetch();
      }
    } catch {
      setError("Could not send that request. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  }

  async function voteOnProposal(proposal: PendingProposal, value: 1 | -1) {
    await settleRequest(proposal.id, `/api/proposals/${proposal.id}/vote`, { value });
  }

  async function decideProposal(proposal: PendingProposal, decision: "approve" | "reject") {
    await settleRequest(proposal.id, `/api/proposals/${proposal.id}/decide`, { decision });
  }

  async function settleRequest(id: string, url: string, payload: Record<string, unknown>) {
    setBusy(`proposal:${id}`);
    setError("");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, token, ...payload }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; status?: string; reason?: string }
        | null;
      if (!res.ok) {
        setError(body?.error || "Could not update that request.");
      } else {
        // A cancelled request is not a failure, but it is the one outcome
        // nobody asked for, so say why rather than letting it vanish.
        if (body?.status === "cancelled" && body.reason) setError(body.reason);
        await refetch();
      }
    } catch {
      setError("Could not update that request. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  }

  async function saveReservation(
    item: BoardItem,
    reservation: Omit<Reservation, "autoLocked" | "artifact" | "organizerVerifiedAt"> & { organizerVerified: boolean },
  ): Promise<boolean> {
    setBusy(`reservation:${item.id}`);
    setError("");
    setSchedulePreview(null);
    try {
      const res = await fetch(`/api/items/${item.id}/reservation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, token, ...reservation }),
      });
      if (!res.ok) {
        setError((await readError(res)) || "Could not save the reservation.");
        return false;
      }
      await refetch();
      return true;
    } catch {
      setError("Could not save the reservation. Check your connection and try again.");
      return false;
    } finally {
      setBusy("");
    }
  }

  async function uploadReservationArtifact(item: BoardItem, file: File): Promise<boolean> {
    if (!token) return false;
    setBusy(`reservation:${item.id}`);
    setError("");
    try {
      const begin = await fetch(`/api/items/${item.id}/reservation/artifact`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [TRIP_TOKEN_HEADER]: token },
        body: JSON.stringify({ slug, fileName: file.name, mediaType: file.type, byteSize: file.size }),
      });
      if (!begin.ok) { setError((await readError(begin)) || "Could not prepare the reservation proof upload."); return false; }
      const issued = await begin.json() as { upload: { id: string; path: string; token: string } };
      const { error: uploadError } = await browserClient().storage
        .from("reservation-proofs")
        .uploadToSignedUrl(issued.upload.path, issued.upload.token, file, {
          contentType: file.type,
          upsert: false,
        });
      if (uploadError) { setError("Could not upload the reservation proof securely."); return false; }
      const finalize = await fetch(`/api/items/${item.id}/reservation/artifact`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", [TRIP_TOKEN_HEADER]: token },
        body: JSON.stringify({ slug, uploadId: issued.upload.id }),
      });
      if (!finalize.ok) { setError((await readError(finalize)) || "Could not finalize the reservation proof."); return false; }
      await refetch();
      return true;
    } catch {
      setError("Could not attach the reservation proof. Check your connection and try again.");
      return false;
    } finally { setBusy(""); }
  }

  async function removeReservationArtifact(item: BoardItem): Promise<void> {
    if (!token) return;
    setBusy(`reservation:${item.id}`);
    setError("");
    try {
      const res = await fetch(`/api/items/${item.id}/reservation/artifact`, {
        method: "DELETE", headers: { "Content-Type": "application/json", [TRIP_TOKEN_HEADER]: token },
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) setError((await readError(res)) || "Could not remove the reservation proof.");
      else await refetch();
    } catch { setError("Could not remove the reservation proof. Check your connection and try again."); }
    finally { setBusy(""); }
  }

  async function downloadReservationArtifact(item: BoardItem): Promise<void> {
    if (!token) return;
    setBusy(`reservation:${item.id}`);
    setError("");
    try {
      const res = await fetch(`/api/items/${item.id}/reservation/artifact?slug=${encodeURIComponent(slug)}`, {
        headers: { [TRIP_TOKEN_HEADER]: token },
      });
      if (!res.ok) { setError((await readError(res)) || "Could not download the reservation proof."); return; }
      const download = await res.json() as { url: string; fileName: string };
      const anchor = document.createElement("a");
      anchor.href = download.url;
      anchor.download = download.fileName;
      anchor.rel = "noopener noreferrer";
      anchor.click();
    } catch { setError("Could not download the reservation proof. Check your connection and try again."); }
    finally { setBusy(""); }
  }

  async function retryReservationArtifactCleanup(item: BoardItem): Promise<void> {
    if (!token) return;
    setBusy(`reservation:${item.id}`);
    setError("");
    try {
      const res = await fetch(`/api/items/${item.id}/reservation/artifact`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", [TRIP_TOKEN_HEADER]: token },
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) setError("Some private proof cleanup is still queued. You can retry safely.");
      await refetch();
    } catch { setError("Could not retry private proof cleanup. Check your connection and try again."); }
    finally { setBusy(""); }
  }

  async function previewSmartReshuffle() {
    if (!board) return;
    setBusy("reshuffle-preview");
    setError("");
    try {
      const res = await fetch(`/api/trips/${slug}/reshuffle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          action: "preview",
          currentDayIndex: getTripTiming(board.trip.startDate, board.trip.endDate).dayIndex,
        }),
      });
      if (!res.ok) {
        setError((await readError(res)) || "Could not preview the reshuffle.");
        return;
      }
      setSchedulePreview(await res.json());
    } catch {
      setError("Could not preview the reshuffle. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  }

  async function previewPartialDay() {
    if (!board) return;
    const timing = getTripTiming(board.trip.startDate, board.trip.endDate);
    setBusy("partial-day-preview");
    setError("");
    try {
      const res = await fetch(`/api/trips/${slug}/reshuffle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          action: "preview-partial-day",
          currentDayIndex: timing.dayIndex,
          currentBlock: currentTodayBlock(),
        }),
      });
      if (!res.ok) {
        setError((await readError(res)) || "Could not preview today's repair.");
        return;
      }
      setSchedulePreview(await res.json());
      requestAnimationFrame(() => document.getElementById("schedule-preview")?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      }));
    } catch {
      setError("Could not preview today's repair. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  }

  async function previewAdjustToday(reason: string) {
    if (!board || !board.me.isOrganizer) return;
    const timing = getTripTiming(board.trip.startDate, board.trip.endDate);
    setBusy("adjust-today-preview");
    setError("");
    try {
      const res = await fetch(`/api/trips/${slug}/adjust`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action: "preview", dayIndex: timing.dayIndex, reason }),
      });
      const body = await res.json().catch(() => null) as AdjustTodayPreviewData | { error?: string } | null;
      if (!res.ok) { setError(body && "error" in body ? body.error ?? "Could not preview adjust today." : "Could not preview adjust today."); return; }
      setAdjustTodayPreview(body as AdjustTodayPreviewData);
      requestAnimationFrame(() => document.getElementById("adjust-today-preview")?.scrollIntoView({ behavior: "smooth", block: "center" }));
    } catch { setError("Could not preview adjust today. Check your connection and try again."); }
    finally { setBusy(""); }
  }

  async function abandonAdjustToday() {
    if (!adjustTodayPreview?.previewId) { setAdjustTodayPreview(null); return; }
    setBusy("adjust-today-abandon");
    try {
      await fetch(`/api/trips/${slug}/adjust`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action: "abandon", previewId: adjustTodayPreview.previewId }) });
    } finally { setAdjustTodayPreview(null); setBusy(""); }
  }

  async function applyAdjustTodayPreview() {
    if (!adjustTodayPreview?.previewId) return;
    setBusy("adjust-today-apply");
    setError("");
    const { impact } = adjustTodayPreview;
    try {
      const res = await fetch(`/api/trips/${slug}/adjust`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action: "apply", previewId: adjustTodayPreview.previewId, fingerprint: adjustTodayPreview.fingerprint, reason: adjustTodayPreview.reason,
          moves: impact.moves, skips: impact.skips, swaps: impact.swaps }),
      });
      if (!res.ok) { setError((await readError(res)) || "This preview is stale. Review today's plan again."); return; }
      setAdjustTodayPreview(null);
      await refetch();
    } catch { setError("Could not apply today's adjustment. No changes were saved."); }
    finally { setBusy(""); }
  }

  /**
   * Ask what the forecast argues against. Previews only — `raiseProposals` is a
   * second, deliberate step, so a scan can never surprise the group.
   */
  async function scanWeather(raiseProposals: boolean) {
    if (!token || !board) return;
    setBusy(raiseProposals ? "weather-raise" : "weather-scan");
    setGenerateError("");
    try {
      const res = await fetch(`/api/trips/${board.trip.slug}/weather-scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: board.trip.slug, token, raiseProposals }),
      });
      const body = await res.json();
      if (!res.ok) {
        setGenerateError(body.error ?? "Could not check the forecast");
        return;
      }
      setWeatherScan(body as WeatherScanResult);
      if (raiseProposals) await refetch();
    } catch {
      setGenerateError("Could not reach the forecast service");
    } finally {
      setBusy("");
    }
  }

  async function applySchedulePreview() {
    if (!schedulePreview) return;
    const hasChanges = schedulePreview.moves.length > 0
      || (schedulePreview.kind === "partial-day" && schedulePreview.skips.length > 0);
    if (!hasChanges) return;
    const isPartialDay = schedulePreview.kind === "partial-day";
    setBusy(isPartialDay ? "partial-day-apply" : "reshuffle-apply");
    setError("");
    try {
      const res = await fetch(`/api/trips/${slug}/reshuffle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isPartialDay ? {
          token,
          action: "apply-partial-day",
          dayIndex: schedulePreview.dayIndex,
          currentBlock: schedulePreview.currentBlock,
          trigger: schedulePreview.trigger,
          moves: schedulePreview.moves,
          skips: schedulePreview.skips,
        } : {
          token,
          action: "apply",
          moves: schedulePreview.moves,
        }),
      });
      if (!res.ok) {
        setError((await readError(res)) || `Could not apply ${isPartialDay ? "today's repair" : "the reshuffle"}.`);
        return;
      }
      setSchedulePreview(null);
      await refetch();
    } catch {
      setError(`Could not apply ${isPartialDay ? "today's repair" : "the reshuffle"}. Check your connection and try again.`);
    } finally {
      setBusy("");
    }
  }

  async function addSuggestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = suggestionText.trim();
    if (!text) return;
    setSuggestionBusy("add");
    setError("");
    try {
      const res = await fetch(`/api/trips/${slug}/suggestions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, text }),
      });
      if (!res.ok) {
        setError((await readError(res)) || "Could not save that suggestion.");
        return;
      }
      setSuggestionText("");
      await refetch();
    } catch {
      setError("Could not save that suggestion. Check your connection and try again.");
    } finally {
      setSuggestionBusy("");
    }
  }

  async function removeSuggestion(suggestionId: string) {
    setSuggestionBusy(suggestionId);
    setError("");
    try {
      const res = await fetch(`/api/trips/${slug}/suggestions/${suggestionId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) setError((await readError(res)) || "Could not remove that suggestion.");
      else await refetch();
    } catch {
      setError("Could not remove that suggestion. Check your connection and try again.");
    } finally {
      setSuggestionBusy("");
    }
  }

  if (!ready) return null;
  if (!token) return <JoinForm slug={slug} onJoined={setToken} />;
  if (!board) {
    if (loadError) {
      return (
        <div className="mx-auto mt-16 max-w-md rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-8 text-center shadow-sm">
          <h1 className="font-[family-name:var(--font-display)] text-2xl text-[#2D2A24]">
            Can&apos;t open this trip
          </h1>
          <p className="mt-3 text-[#8A8272]">{loadError}</p>
          <button
            onClick={() => {
              setLoadError("");
              refetch();
            }}
            className="mt-6 rounded-full bg-[#C2571B] px-5 py-2.5 font-semibold text-white transition hover:bg-[#A84A15]"
          >
            Try again
          </button>
        </div>
      );
    }
    return <p className="p-6 text-[#8A8272]">Loading trip…</p>;
  }

  const myName = board.travelers.find((t) => t.id === board.me.id)?.displayName ?? "you";
  const resumeUrl =
    typeof window === "undefined" || !token ? "" : buildResumeUrl(window.location.origin, slug, token);
  const selectedDay = day ?? getTripTiming(board.trip.startDate, board.trip.endDate).dayIndex;

  const dayItems = board.items
    .filter((item) => item.dayIndex === selectedDay ||
      (item.status === "done" && item.completedDayIndex === selectedDay))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .sort((a, b) =>
      BLOCK_ORDER.indexOf(a.block) - BLOCK_ORDER.indexOf(b.block)
      || ["done", "planned", "skipped"].indexOf(a.status)
        - ["done", "planned", "skipped"].indexOf(b.status),
    );
  const hasProgress = board.items.some((item) => item.status !== "planned" || item.isLocked);

  // Removed stops stay in the record but out of the way: the group is reading
  // this on a phone in the street, and a plan padded with things they already
  // dropped is the complaint that started this.
  const activeItems = dayItems.filter((item) => item.status !== "skipped");
  const removedItems = dayItems.filter((item) => item.status === "skipped");

  const planEdit = canManageSchedule({ actorIsOrganizer: board.me.isOrganizer });
  const takenSlots = new Set(
    board.items
      .filter((item) => item.status === "planned")
      .map((item) => `${item.dayIndex}:${item.block}`),
  );
  const visibleItems = showRemoved ? [...activeItems, ...removedItems] : activeItems;
  const humanTravelers = board.travelers.filter((t) => !t.isBot);
  const openProposals = board.proposals ?? [];
  const proposalByItemId = new Map(openProposals.map((proposal) => [proposal.itemId, proposal]));
  const venueNameByItemId = new Map(board.items.map((item) => [item.id, item.venue.name]));

  return (
    <div className="mx-auto max-w-3xl p-4">
      <header className="mb-4">
        <div className="relative mb-4 h-44 w-full overflow-hidden rounded-2xl border border-[#EADFCC] bg-[#F3E0D3] sm:h-56">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/trips/${slug}/photo`}
            alt={board.trip.destinationName}
            className="h-full w-full object-cover"
            onError={(e) => {
              // Small towns sometimes have no photo; drop the hero rather than show a broken frame.
              (e.currentTarget.parentElement as HTMLElement).style.display = "none";
            }}
          />
        </div>
        <div className="flex items-start gap-2">
          <h1 className="font-display text-3xl font-semibold text-[#2D2A24] sm:text-4xl">
            {board.trip.title || board.trip.destinationName}
          </h1>
          {board.me.isOrganizer && (
            <button
              onClick={rename}
              aria-label="Rename this trip"
              title="Rename this trip"
              className="mt-2 shrink-0 rounded-full px-2 py-1 text-sm text-[#8A8272] transition hover:bg-[#F3E0D3] hover:text-[#2D2A24]"
            >
              ✏️
            </button>
          )}
        </div>
        <p className="mt-1 text-xs uppercase tracking-wide text-[#8A8272]">
          {board.trip.startDate} → {board.trip.endDate}
          {board.trip.title ? ` · ${board.trip.destinationName}` : ""}
        </p>
        <button
          onClick={() => setShowRoster((v) => !v)}
          className="mt-2 rounded-full border border-[#EADFCC] px-3 py-1 text-sm text-[#2D2A24] transition hover:bg-[#F3E0D3]"
        >
          👥 Who&apos;s coming ({board.travelers.length})
        </button>

        {showRoster && (
          <ul className="mt-2 flex flex-col gap-2">
            {board.travelers.map((t) => (
              <li
                key={t.id}
                className="rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-4 shadow-sm"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="font-display text-lg text-[#2D2A24]">{t.displayName}</span>
                    {t.isOrganizer && (
                      <span className="ml-2 rounded-full bg-[#F3E0D3] px-2 py-0.5 text-xs text-[#8A6D1F]">
                        organiser
                      </span>
                    )}
                    {t.isBot && (
                      <span
                        className="ml-2 rounded-full bg-[#E5DED2] px-2 py-0.5 text-xs text-[#756B5E]"
                        title="Assistants don't count toward a group vote"
                      >
                        assistant · no vote
                      </span>
                    )}
                    <p className="mt-1 text-xs uppercase tracking-wide text-[#8A8272]">
                      joined {new Date(t.joinedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                      {" · "}
                      {t.voteCount > 0
                        ? `${t.voteCount} ${t.voteCount === 1 ? "vote" : "votes"} on this plan`
                        : "no votes yet"}
                    </p>
                  </div>
                  {board.me.isOrganizer && t.id !== board.me.id && (
                    <button
                      onClick={() => removeTraveler(t.id, t.displayName)}
                      aria-label={`Remove ${t.displayName} from this trip`}
                      className="shrink-0 rounded-full px-2 py-1 text-[#8A8272] transition hover:bg-[#F3E0D3] hover:text-[#2D2A24]"
                    >
                      ✕
                    </button>
                  )}
                </div>

                <div className="mt-2 flex flex-wrap gap-1">
                  {t.interests.map((i) => (
                    <span
                      key={i}
                      className="rounded-full border border-[#EADFCC] px-2 py-0.5 text-xs text-[#2D2A24]"
                    >
                      {i}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-sm text-[#8A8272]">
                  {t.pace} pace · {t.dietary === "none" ? "no dietary needs" : t.dietary}
                </p>
                {t.constraintsNote && (
                  <p className="mt-1 text-sm italic text-[#2D2A24]">“{t.constraintsNote}”</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-sm text-[#8A8272]">🔗 Anyone with this link can join and edit.</p>

        {/* Two very different links live here, so they are kept visually apart:
            the page URL invites people, this one carries your own identity. */}
        <button
          onClick={() => setShowResume((v) => !v)}
          className="mt-2 rounded-full border border-[#EADFCC] px-3 py-1 text-sm text-[#2D2A24] transition hover:bg-[#F3E0D3]"
        >
          📱 Use on another device
        </button>

        {board.me.isOrganizer && alerts?.available && (
          <button
            onClick={linkTelegram}
            disabled={busy === "telegram" || alerts.linked}
            className="ml-2 mt-2 rounded-full border border-[#EADFCC] px-3 py-1 text-sm text-[#2D2A24] transition hover:bg-[#F3E0D3] disabled:opacity-60"
          >
            {alerts.linked
              ? "✓ Telegram alerts on"
              : busy === "telegram"
                ? "Opening Telegram…"
                : "🔔 Get Telegram alerts"}
          </button>
        )}
        {showResume && token && (
          <div className="mt-2 rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-4 shadow-sm">
            <p className="text-sm text-[#2D2A24]">
              Open this on your other phone or laptop to be <strong>{myName}</strong> there too.
            </p>
            <p className="mt-1 text-sm text-[#B0532F]">
              Private to you — don&apos;t put it in the family chat. Anyone who opens it becomes you
              on this trip.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                readOnly
                value={resumeUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-xl border border-[#EADFCC] bg-white/70 p-2 text-xs text-[#8A8272]"
              />
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(resumeUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  } catch {
                    setError("Couldn't copy — select the link and copy it manually.");
                  }
                }}
                className="shrink-0 rounded-full bg-[#C2571B] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#A84A15]"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </header>

      {board.me.isOrganizer && token && board.travelers.some(traveler => traveler.id === board.me.id && traveler.isBot === false) && (
        <AgentConnectionSetup slug={slug} token={token} travelers={board.travelers} actorId={board.me.id} duringTrip={getTripTiming(board.trip.startDate, board.trip.endDate).phase === "during"} />
      )}

      {board.items.length > 0 && (
        <TodayMode
          trip={board.trip}
          items={board.items}
          isOrganizer={board.me.isOrganizer}
          busy={busy}
          onSelectDay={(dayIndex) => {
            setDay(dayIndex);
            requestAnimationFrame(() => document.getElementById("full-itinerary")?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            }));
          }}
          onUpdateActivity={(itemId, status) => {
            const item = board.items.find((candidate) => candidate.id === itemId);
            if (item) updateActivity(item, { action: "status", status });
          }}
          onPreviewReshuffle={previewSmartReshuffle}
          onPreviewPartialDay={previewPartialDay}
          onAdjustToday={previewAdjustToday}
          adjustTodayBusy={busy === "adjust-today-preview"}
          onAskConcierge={(text) => {
            setConciergePrompt((current) => ({ id: (current?.id ?? 0) + 1, text }));
            requestAnimationFrame(() => document.getElementById("trip-concierge")?.scrollIntoView({
              behavior: "smooth",
              block: "center",
            }));
          }}
        />
      )}

      <section className="mb-4 rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-4 shadow-sm">
        <h2 className="font-display text-xl font-semibold text-[#2D2A24]">Have a place in mind?</h2>
        <p className="mt-1 text-sm text-[#8A8272]">
          Add a place or an idea. The next generated plan will try to include it when it fits.
        </p>
        <form onSubmit={addSuggestion} className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            value={suggestionText}
            onChange={(event) => setSuggestionText(event.target.value)}
            maxLength={240}
            placeholder="e.g. Visit the Blue Eye, or a quiet seafood place"
            aria-label="Place suggestion"
            className="min-w-0 flex-1 rounded-xl border border-[#EADFCC] bg-white/70 px-3 py-2 text-[#2D2A24] outline-none placeholder:text-[#AAA18F] focus:border-[#C2571B]"
          />
          <button
            type="submit"
            disabled={!suggestionText.trim() || suggestionBusy === "add"}
            className="rounded-full bg-[#C2571B] px-5 py-2 font-semibold text-white transition hover:bg-[#A84A15] disabled:opacity-50"
          >
            {suggestionBusy === "add" ? "Adding…" : "Add suggestion"}
          </button>
        </form>

        {board.suggestions.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {board.suggestions.map((suggestion) => (
              <li
                key={suggestion.id}
                className="flex items-start gap-3 rounded-xl bg-[#F7F0E5] px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-[#2D2A24]">“{suggestion.text}”</p>
                  <p className="mt-0.5 text-xs text-[#8A8272]">Suggested by {suggestion.displayName}</p>
                </div>
                {suggestion.canDelete && (
                  <button
                    onClick={() => removeSuggestion(suggestion.id)}
                    disabled={suggestionBusy === suggestion.id}
                    aria-label={`Remove suggestion from ${suggestion.displayName}`}
                    title="Remove suggestion"
                    className="shrink-0 rounded-full px-2 py-1 text-sm text-[#8A8272] transition hover:bg-[#EADFCC] hover:text-[#2D2A24] disabled:opacity-50"
                  >
                    {suggestionBusy === suggestion.id ? "…" : "✕"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {board.suggestions.length > 0 && !board.me.isOrganizer && (
          <p className="mt-3 text-xs text-[#8A8272]">
            The organiser can regenerate the plan with these suggestions.
          </p>
        )}
      </section>

      <TripConcierge slug={slug} token={token} promptRequest={conciergePrompt} />

      {board.items.length === 0 ? (
        <div className="rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-6 text-center shadow-sm">
          <p className="mb-4 text-[#2D2A24]">No plan yet.</p>
          {board.me.isOrganizer ? (
            <button
              onClick={generate}
              disabled={busy === "generate" || busy === "venues"}
              className="rounded-full bg-[#C2571B] px-8 py-3 text-lg font-semibold text-white transition hover:bg-[#A84A15] disabled:opacity-50"
            >
              {busy === "venues"
                ? "Finding places…"
                : busy === "generate"
                  ? "Building your plan…"
                  : "✨ Generate plan"}
            </button>
          ) : (
            <p className="text-[#8A8272]">Waiting for the organizer to generate the plan.</p>
          )}
          {board.me.isOrganizer && board.travelers.length < 2 && (
            <p className="mt-3 text-sm text-[#8A8272]">
              Only you so far — share the link so the plan reflects everyone.
            </p>
          )}
          {/* The shared error line lives at the foot of the board, past the whole
              itinerary. When generation is what failed there is no itinerary to
              scroll past, so on a phone the message sat off-screen and the button
              simply appeared to do nothing. Say it where the tap happened. */}
          {generateError && (
            <p className="mt-4 rounded-xl bg-[#F9E4DE] px-4 py-3 text-left text-sm text-[#B0532F]">
              {generateError}
            </p>
          )}
        </div>
      ) : (
        <>
          {/* Regenerate sits outside the scrolling strip: inside it, a long trip
              pushes the button off the right edge where nobody can find it. */}
          <div id="full-itinerary" className="mb-4 flex scroll-mt-4 items-center gap-2">
            <nav className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
              {Array.from({ length: board.trip.dayCount }, (_, i) => (
                <button
                  key={i}
                  onClick={() => setDay(i)}
                  className={`shrink-0 rounded-full px-3 py-1 transition ${
                    i === selectedDay
                      ? "bg-[#C2571B] text-white"
                      : "border border-[#EADFCC] text-[#2D2A24] hover:bg-[#F3E0D3]"
                  }`}
                >
                  <span className="block text-[10px] leading-tight opacity-70">
                    {getTripDayDisplay(board.trip.startDate, i).isToday ? "Today" : `Day ${i + 1}`}
                  </span>
                  <span className="block text-sm leading-tight">
                    {getTripDayDisplay(board.trip.startDate, i).shortDate}
                  </span>
                </button>
              ))}
            </nav>
            {board.me.isOrganizer && !hasProgress && (
              <button
                onClick={generate}
                disabled={busy === "generate" || busy === "venues"}
                className="shrink-0 rounded-full border border-[#EADFCC] px-3 py-1 text-[#2D2A24] transition hover:bg-[#F3E0D3] disabled:opacity-50"
                title="Rebuild the whole plan from everyone's preferences"
              >
                {busy === "venues" || busy === "generate" ? "Regenerating…" : "↻ Regenerate"}
              </button>
            )}
            {board.me.isOrganizer && (
              <button
                onClick={() => scanWeather(false)}
                disabled={busy === "weather-scan" || busy === "weather-raise"}
                className="shrink-0 rounded-full border border-[#EADFCC] px-3 py-1 text-[#2D2A24] transition hover:bg-[#F3E0D3] disabled:opacity-50"
                title="See which outdoor activities the forecast argues against"
              >
                {busy === "weather-scan" ? "Checking…" : "☂ Check forecast"}
              </button>
            )}
            {board.me.isOrganizer && hasProgress && (
              <button
                onClick={previewSmartReshuffle}
                disabled={[
                  "reshuffle-preview", "reshuffle-apply", "partial-day-preview", "partial-day-apply",
                ].includes(busy)}
                className="shrink-0 rounded-full bg-[#C2571B] px-3 py-1 font-semibold text-white transition hover:bg-[#A84A15] disabled:opacity-50"
                title="Safely rearrange unfinished activities around completed and locked plans"
              >
                {busy === "reshuffle-preview" ? "Planning…" : "✨ Smart reshuffle"}
              </button>
            )}
          </div>

          {/* A regeneration that fails leaves the old plan in place, so without
              this the group sees an unchanged board and no reason why. */}
          {generateError && (
            <p className="mb-4 rounded-xl bg-[#F9E4DE] px-4 py-3 text-sm text-[#B0532F]">
              {generateError}
            </p>
          )}

          {weatherScan && (
            <WeatherAdvisory
              result={weatherScan}
              startDate={board.trip.startDate}
              busy={busy === "weather-raise"}
              onRaise={() => scanWeather(true)}
              onClose={() => setWeatherScan(null)}
            />
          )}

          {schedulePreview && (
            <SchedulePreview
              preview={schedulePreview}
              busy={busy}
              onClose={() => setSchedulePreview(null)}
              onApply={applySchedulePreview}
            />
          )}

          {adjustTodayPreview && (
            <AdjustTodayPreview
              preview={adjustTodayPreview}
              busy={busy === "adjust-today-apply" || busy === "adjust-today-abandon"}
              onAbandon={abandonAdjustToday}
              onApply={applyAdjustTodayPreview}
            />
          )}

          {board.latestAdjustTodayRevision && (
            <section className="mb-4 rounded-2xl border border-[#C9D8BF] bg-[#F4F8F1] p-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-[#5F7A54]">Accepted revision · visible to the group</p>
              <p className="mt-1 text-sm text-[#46613D]">Day {board.latestAdjustTodayRevision.dayIndex + 1}: “{board.latestAdjustTodayRevision.reason}”</p>
              <p className="mt-1 text-xs text-[#5F7A54]">Accepted by {board.latestAdjustTodayRevision.actorName} · {new Date(board.latestAdjustTodayRevision.createdAt).toLocaleString()} · changes are recorded with the organizer who accepted them.</p>
            </section>
          )}

          <PendingRequests
            proposals={openProposals}
            venueNameById={venueNameByItemId}
            isOrganizer={board.me.isOrganizer}
            busyId={busy.startsWith("proposal:") ? busy.slice("proposal:".length) : ""}
            onVote={voteOnProposal}
            onDecide={decideProposal}
          />

          {preferenceCoverage && <PreferenceCoverageSummary report={preferenceCoverage} />}

          {(dayItems.find((item) => item.status === "planned") ?? dayItems[0])?.area && (
            <p className="mb-3 font-display text-lg text-[#2D2A24]">
              {getTripDayDisplay(board.trip.startDate, selectedDay).fullDate} · <span className="text-[#C2571B]">
                {(dayItems.find((item) => item.status === "planned") ?? dayItems[0]).area}
              </span>
            </p>
          )}

          {(() => {
            // Who is not here today. A plan is easy to build around someone who
            // has already flown home, and nothing else on the board says so.
            const { present, absent } = attendanceForDay(
              board.travelers, board.trip.startDate, selectedDay,
            );
            if (absent.length === 0) return null;
            const names = absent.map((t) => t.displayName).join(", ");
            return (
              <p className={`mb-3 rounded-xl border px-3 py-2 text-sm ${
                present.length === 0
                  ? "border-[#E8B4A2] bg-[#FFF1EC] text-[#9C3B12]"
                  : "border-[#E5D39E] bg-[#FFF9E8] text-[#8A6D1F]"
              }`}>
                {present.length === 0
                  ? `Nobody is here on this day — ${names} all arrive later.`
                  : `Not here today: ${names}.`}
              </p>
            );
          })()}

          <DayMap
            center={{ lat: board.trip.lat, lng: board.trip.lng }}
            pins={dayItems
              .filter((item) => item.status === "planned" || item.completedDayIndex === selectedDay)
              .map((item) => ({ lat: item.venue.lat, lng: item.venue.lng, label: item.venue.name }))}
          />

          <ul className="mt-4 flex flex-col gap-3">
            {visibleItems.map((item) => (
              <li
                key={item.id}
                className={`rounded-2xl border p-3 shadow-sm transition hover:shadow-md ${
                  item.status === "done"
                    ? "border-[#C9D8BF] bg-[#F4F8F1]"
                    : item.status === "skipped"
                      ? "border-[#DDD5C8] bg-[#F5F1EA] opacity-75"
                      : "border-[#EADFCC] bg-[#FFFDF8]"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-[#C2571B]">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#C2571B]" />
                        {item.block}
                      </span>
                      {item.status === "done" && (
                        <span className="rounded-full bg-[#DCEAD4] px-2 py-0.5 text-xs font-semibold text-[#46613D]">✓ Done</span>
                      )}
                      {item.status === "skipped" && (
                        <span className="rounded-full bg-[#E5DED2] px-2 py-0.5 text-xs font-semibold text-[#756B5E]">Removed</span>
                      )}
                      {item.isLocked && (
                        <span className="rounded-full bg-[#F5E6C8] px-2 py-0.5 text-xs font-semibold text-[#8A6D1F]">🔒 Locked</span>
                      )}
                    </div>
                    <h3 className="font-display text-lg font-semibold text-[#2D2A24]">
                      <a href={item.venue.mapsUrl} target="_blank" rel="noreferrer" className="hover:text-[#C2571B] hover:underline">
                        {item.venue.name} ↗
                      </a>
                    </h3>
                    <p className="text-sm text-[#8A8272]">
                      {item.venue.rating ? `★ ${item.venue.rating} (${item.venue.reviewCount})` : "unrated"} · ~{item.durationMin} min
                      {item.travelWarning && (
                        <span className="ml-2 rounded-full bg-[#F5E6C8] px-2 text-[#8A6D1F]">⚠ far from previous stop</span>
                      )}
                    </p>
                    <p className="text-sm italic text-[#2D2A24]">{item.whyNote}</p>
                    <ReservationDetails
                      reservation={item.reservation}
                      isOrganizer={board.me.isOrganizer}
                      busy={busy === `reservation:${item.id}`}
                      onSave={(reservation) => saveReservation(item, reservation)}
                      onUploadArtifact={(file) => uploadReservationArtifact(item, file)}
                      onRemoveArtifact={() => removeReservationArtifact(item)}
                      onDownloadArtifact={() => downloadReservationArtifact(item)}
                      onRetryArtifactCleanup={() => retryReservationArtifactCleanup(item)}
                    />
                    {board.me.isOrganizer ? (
                      (item.reservationAttempt === null || isOrganizerReservationAttempt(item.reservationAttempt)) &&
                        <ReservationAssistance itemId={item.id} slug={slug} token={token!} venueName={item.venue.name} attempt={item.reservationAttempt} onChanged={() => void refetch()} />
                    ) : item.reservationAttempt && (
                      <p className="mt-2 text-xs font-medium text-[#756B5E]">
                        Reservation assistance: {item.reservationAttempt.state.replaceAll("_", " ")}
                        {item.reservationAttempt.state === "confirmed" && item.reservationAttempt.confirmationReference
                          ? ` · confirmation ${item.reservationAttempt.confirmationReference}` : ""}
                      </p>
                    )}
                    {preferenceCoverage && item.status !== "skipped" && (
                      <ActivityPreferenceFit
                        activity={preferenceCoverage.activities.find((activity) => activity.itemId === item.id)}
                        report={preferenceCoverage}
                      />
                    )}
                    {item.status === "done" && item.completedDayIndex !== null && (
                      <p className="mt-1 text-sm font-medium text-[#5F7A54]">
                        {item.completedDayIndex === item.dayIndex
                          ? `Completed on Day ${item.completedDayIndex + 1}`
                          : selectedDay === item.completedDayIndex
                            ? `Completed here · originally planned for Day ${item.dayIndex + 1}`
                            : `Completed early on Day ${item.completedDayIndex + 1} · ${
                                hasPlannedReplacement(board.items, item) ? "replaced in the plan" : "this slot is open"
                              }`}
                        {item.stateChangedByName ? ` by ${item.stateChangedByName}` : ""}
                      </p>
                    )}
                    {item.status === "skipped" && (
                      <p className="mt-1 text-sm text-[#756B5E]">
                        This slot is open{item.stateChangedByName ? ` · updated by ${item.stateChangedByName}` : ""}
                      </p>
                    )}
                  </div>
                  {item.status === "planned" && (
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <div className="flex gap-1">
                        <button
                          onClick={() => vote(item.id, 1)}
                          className={`rounded-full px-2 py-1 transition ${
                            item.myVote === 1
                              ? "bg-[#E4EDDD] ring-1 ring-[#5F7A54]"
                              : "border border-[#EADFCC] hover:bg-[#F3E0D3]"
                          }`}
                        >
                          👍
                        </button>
                        <button
                          onClick={() => vote(item.id, -1)}
                          className={`rounded-full px-2 py-1 transition ${
                            item.myVote === -1
                              ? "bg-[#F5DFDA] ring-1 ring-[#B0532F]"
                              : "border border-[#EADFCC] hover:bg-[#F3E0D3]"
                          }`}
                        >
                          👎
                        </button>
                      </div>
                      <span className="rounded-full bg-[#F3E0D3] px-2 text-sm text-[#8A8272]">
                        {item.voteSum > 0 ? `+${item.voteSum}` : item.voteSum}
                      </span>
                      {!item.isLocked && (() => {
                        const gate = canSwap({
                          voteSum: item.voteSum,
                          isOrganizer: board.me.isOrganizer,
                          travelerCount: humanTravelers.length,
                        });
                        return (
                          <>
                            <button
                              onClick={() => swap(item.id)}
                              disabled={busy === item.id || !gate.allowed}
                              title={gate.allowed ? undefined : gate.reason}
                              className="rounded-full border border-[#EADFCC] px-2 py-1 text-sm text-[#2D2A24] transition hover:bg-[#F3E0D3] disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {busy === item.id ? "Swapping…" : "Swap"}
                            </button>
                            {!gate.allowed && (
                              <span className="max-w-28 text-right text-xs leading-tight text-[#8A8272]">
                                {gate.reason}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-2 border-t border-[#EADFCC]/70 pt-3">
                  {item.status === "planned" ? (
                    <>
                      <button
                        onClick={() => updateActivity(item, { action: "status", status: "done" })}
                        disabled={busy === `state:${item.id}`}
                        className="rounded-full bg-[#5F7A54] px-3 py-1 text-sm font-semibold text-white transition hover:bg-[#4C6544] disabled:opacity-50"
                      >
                        ✓ Done today
                      </button>
                      {planEdit.allowed ? (
                        <button
                          onClick={() => updateActivity(item, { action: "status", status: "skipped" })}
                          disabled={busy === `state:${item.id}`}
                          className="rounded-full border border-[#EADFCC] px-3 py-1 text-sm text-[#756B5E] transition hover:bg-[#F3E0D3] disabled:opacity-50"
                        >
                          Remove
                        </button>
                      ) : (
                        !item.isLocked && !proposalByItemId.has(item.id) && (
                          <button
                            onClick={() => proposeChange(item, { kind: "remove" })}
                            disabled={busy === `propose:${item.id}`}
                            className="rounded-full border border-[#EADFCC] px-3 py-1 text-sm text-[#756B5E] transition hover:bg-[#F3E0D3] disabled:opacity-50"
                          >
                            Ask to drop
                          </button>
                        )
                      )}
                      {!planEdit.allowed && proposalByItemId.has(item.id) && (
                        <span className="self-center text-xs font-medium text-[#8A6D1F]">
                          ⏳ A change is already waiting on this
                        </span>
                      )}
                      {!item.isLocked && (planEdit.allowed || !proposalByItemId.has(item.id)) && (
                        <button
                          onClick={() => {
                            const opening = movingItemId !== item.id;
                            setMovingItemId(opening ? item.id : "");
                            setMoveTarget(opening ? { dayIndex: item.dayIndex, block: item.block } : null);
                          }}
                          disabled={busy === `move:${item.id}` || busy === `propose:${item.id}`}
                          className="rounded-full border border-[#EADFCC] px-3 py-1 text-sm text-[#2D2A24] transition hover:bg-[#F3E0D3] disabled:opacity-50"
                        >
                          {movingItemId === item.id
                            ? "Cancel"
                            : planEdit.allowed
                              ? "↔ Move"
                              : "↔ Ask to move"}
                        </button>
                      )}
                      {board.me.isOrganizer && !["tentative", "confirmed"].includes(item.reservation.status) && (
                        <button
                          onClick={() => updateActivity(item, { action: "lock", isLocked: !item.isLocked })}
                          disabled={busy === `state:${item.id}`}
                          className="rounded-full border border-[#D9C49E] px-3 py-1 text-sm text-[#8A6D1F] transition hover:bg-[#F5E6C8] disabled:opacity-50"
                        >
                          {item.isLocked ? "🔓 Unlock" : "🔒 Lock manually"}
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      onClick={() => updateActivity(item, { action: "status", status: "planned" })}
                      disabled={busy === `state:${item.id}`}
                      className="rounded-full border border-[#EADFCC] px-3 py-1 text-sm text-[#2D2A24] transition hover:bg-white disabled:opacity-50"
                    >
                      {item.status === "skipped" ? "Put back" : "Undo"}
                    </button>
                  )}
                </div>
                {movingItemId === item.id && moveTarget && (
                  <div className="mt-3 rounded-xl border border-[#EADFCC] bg-[#FFFDF8] p-3">
                    <p className="mb-2 text-sm font-semibold text-[#2D2A24]">
                      {planEdit.allowed ? "Move" : "Ask the group to move"} {item.venue.name} to
                    </p>
                    {/* Stacked on a phone: three controls in one row is where this
                        breaks, and this panel exists to be used standing in the street. */}
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                      <select
                        value={moveTarget.dayIndex}
                        onChange={(e) =>
                          setMoveTarget({ ...moveTarget, dayIndex: Number(e.target.value) })
                        }
                        className="w-full rounded-full border border-[#EADFCC] bg-white px-3 py-2 text-sm text-[#2D2A24] sm:w-auto sm:py-1"
                      >
                        {Array.from({ length: board.trip.dayCount }, (_, index) => (
                          <option key={index} value={index}>
                            Day {index + 1} — {getTripDayDisplay(board.trip.startDate, index).shortDate}
                          </option>
                        ))}
                      </select>
                      <select
                        value={moveTarget.block}
                        onChange={(e) => setMoveTarget({ ...moveTarget, block: e.target.value })}
                        className="w-full rounded-full border border-[#EADFCC] bg-white px-3 py-2 text-sm text-[#2D2A24] sm:w-auto sm:py-1"
                      >
                        {BLOCK_ORDER.map((block) => {
                          const slot = `${moveTarget.dayIndex}:${block}`;
                          const isCurrentSlot =
                            moveTarget.dayIndex === item.dayIndex && block === item.block;
                          const taken = takenSlots.has(slot) && !isCurrentSlot;
                          return (
                            <option key={block} value={block} disabled={taken}>
                              {block}{taken ? " — taken" : ""}
                            </option>
                          );
                        })}
                      </select>
                      <button
                        onClick={() =>
                          planEdit.allowed
                            ? moveActivity(item, moveTarget.dayIndex, moveTarget.block)
                            : proposeChange(item, {
                                kind: "move",
                                toDayIndex: moveTarget.dayIndex,
                                toBlock: moveTarget.block,
                              })
                        }
                        disabled={
                          busy === `move:${item.id}`
                          || busy === `propose:${item.id}`
                          || takenSlots.has(`${moveTarget.dayIndex}:${moveTarget.block}`)
                          || (moveTarget.dayIndex === item.dayIndex && moveTarget.block === item.block)
                        }
                        className="w-full rounded-full bg-[#C2571B] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#A84A15] disabled:opacity-50 sm:w-auto sm:py-1"
                      >
                        {busy === `move:${item.id}` || busy === `propose:${item.id}`
                          ? "Sending…"
                          : planEdit.allowed
                            ? "Move here"
                            : "Ask the group"}
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-[#8A8272]">
                      Only empty slots can take an activity. Locked and booked stops stay put.
                      {!planEdit.allowed
                        && " It moves once the organiser approves or more than half the group agrees."}
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {removedItems.length > 0 && (
            <button
              onClick={() => setShowRemoved(!showRemoved)}
              className="mt-3 w-full rounded-full border border-dashed border-[#DDD5C8] px-3 py-2 text-sm text-[#756B5E] transition hover:bg-[#F5F1EA]"
            >
              {showRemoved ? "Hide" : "Show"} {removedItems.length} removed from this day
            </button>
          )}
        </>
      )}
      {error && <p className="mt-4 text-red-600">{error}</p>}
    </div>
  );
}
