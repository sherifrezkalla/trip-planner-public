"use client";

import { useState } from "react";
import { fromDateTimeLocalValue } from "@/lib/reservations";
import type { ReservationAttempt } from "@/lib/reservation-assistance";

export default function ReservationAssistance({ itemId, slug, token, venueName, attempt: initial, onChanged }: {
  itemId: string; slug: string; token: string; venueName: string; attempt: ReservationAttempt | null; onChanged: () => void;
}) {
  const [attempt, setAttempt] = useState(initial);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const alternatives = [form.get("alternative1"), form.get("alternative2")].filter(Boolean).map((v) => fromDateTimeLocalValue(String(v))!);
    const routes = [form.get("route1"), form.get("route2")].filter(Boolean).map(String);
    const response = await fetch(`/api/items/${itemId}/reservation-assistance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      slug, token, partySize: Number(form.get("partySize")), requestedAt: fromDateTimeLocalValue(String(form.get("requestedAt"))),
      bookingName: form.get("bookingName"), contactEmail: form.get("contactEmail") || null,
      contactPhone: form.get("contactPhone") || null, alternatives, routes,
    }) });
    const body = await response.json(); setBusy(false);
    if (!response.ok) return setError(body.error ?? "Could not prepare the reservation");
    setAttempt(body.attempt); setOpen(false); onChanged();
  }

  async function act(action: string, extra: Record<string, string> = {}) {
    if (busy) return; setBusy(true); setError("");
    const response = await fetch(`/api/items/${attempt!.id}/reservation-assistance`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, token, action, ...extra }) });
    const body = await response.json(); setBusy(false);
    if (!response.ok) return setError(body.error ?? "Could not update the attempt");
    setAttempt(body.attempt); onChanged();
    if (body.route) window.open(body.route, "_blank", "noopener,noreferrer");
  }

  const canEndAttempt = attempt !== null && ["awaiting_approval", "in_progress", "needs_choice", "handoff"].includes(attempt.state);

  if (!attempt) return <div className="mt-2">
    {!open ? <button onClick={() => setOpen(true)} className="rounded-full border border-[#C2571B] px-3 py-1 text-sm font-semibold text-[#C2571B]">Try to reserve</button> :
      <form onSubmit={create} className="mt-2 grid gap-2 rounded-xl border border-[#D9C49E] bg-[#FFF8EA] p-3 sm:grid-cols-2">
        <p className="text-sm font-semibold sm:col-span-2">Prepare a request for {venueName}. Nothing is submitted until you approve the review.</p>
        <Field name="partySize" label="Party size" type="number" min="1" max="30" required />
        <Field name="requestedAt" label="Requested date and time" type="datetime-local" required />
        <Field name="bookingName" label="Booking name" required />
        <Field name="contactEmail" label="Email" type="email" />
        <Field name="contactPhone" label="Phone" type="tel" />
        <Field name="route1" label="Primary booking URL" type="url" required />
        <Field name="route2" label="Fallback booking URL" type="url" />
        <Field name="alternative1" label="Acceptable alternative" type="datetime-local" />
        <Field name="alternative2" label="Second alternative" type="datetime-local" />
        <p className="text-xs text-[#756B5E] sm:col-span-2">Contact details stay organizer-only. Supported HTTPS booking pages open only after approval.</p>
        {error && <p className="text-sm text-red-700 sm:col-span-2">{error}</p>}
        <div className="flex gap-2 sm:col-span-2"><button disabled={busy} className="rounded-full bg-[#C2571B] px-4 py-2 text-sm font-semibold text-white">{busy ? "Preparing…" : "Review request"}</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
      </form>}
  </div>;

  return <div className="mt-2 rounded-xl border border-[#D9C49E] bg-[#FFF8EA] p-3 text-sm">
    <p className="font-semibold">Reservation assistance · {attempt.state.replaceAll("_", " ")}</p>
    <p>{new Date(attempt.requestedAt).toLocaleString()} · {attempt.partySize} people</p>
    {attempt.state === "awaiting_approval" && <><p className="mt-2">Review: request for {attempt.bookingName}. {attempt.contactEmail || attempt.contactPhone ? `Use ${attempt.contactEmail || attempt.contactPhone}.` : "Contact details will be supplied on the external site."} Open {attempt.routes.length} venue or booking route(s) to check availability. Nothing has been booked.</p><button disabled={busy} onClick={() => act("approve")} className="mt-2 rounded-full bg-[#C2571B] px-4 py-2 font-semibold text-white">Approve and open booking route</button></>}
    {attempt.state === "in_progress" && <div className="mt-2 flex flex-wrap gap-2"><a href={attempt.routes[attempt.routeIndex]} target="_blank" rel="noreferrer" className="rounded-full bg-[#C2571B] px-3 py-1 text-white">Open current route ↗</a><button disabled={busy} onClick={() => act("route_failed")} className="rounded-full border px-3 py-1">Unavailable / route failed</button></div>}
    {attempt.state === "needs_choice" && <div className="mt-2 flex flex-wrap gap-2">{attempt.alternatives.map((time) => <button key={time} onClick={() => act("choose_alternative", { alternativeAt: time })} className="rounded-full border px-3 py-1">Try {new Date(time).toLocaleString()}</button>)}</div>}
    {["in_progress", "handoff"].includes(attempt.state) && <div className="mt-2 flex gap-2"><input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder="Confirmation reference" className="min-w-0 rounded-lg border bg-white px-2"/><button disabled={!confirmation || busy} onClick={() => act("confirm", { confirmationReference: confirmation })} className="rounded-full border px-3 py-1">Verify confirmation</button></div>}
    {attempt.handoff && <p className="mt-2 rounded-lg bg-white p-2">{attempt.handoff}</p>}
    {canEndAttempt && <button disabled={busy} onClick={() => act("fail")} className="mt-2 text-xs font-semibold text-[#756B5E] underline">End attempt and start over</button>}
    {attempt.state === "confirmed" && <p className="mt-2 font-semibold text-[#46613D]">Verified confirmation: {attempt.confirmationReference}</p>}
    {error && <p className="mt-2 text-red-700">{error}</p>}
  </div>;
}

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...input } = props; return <label className="text-sm">{label}<input {...input} className="mt-1 w-full rounded-lg border border-[#EADFCC] bg-white px-3 py-2" /></label>;
}
