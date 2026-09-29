"use client";

import { useState } from "react";
import {
  cancellationRisk,
  formatReservationDate,
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
  type ReservationDetails as Reservation,
  type ReservationStatus,
} from "@/lib/reservations";

const STATUS_LABEL: Record<ReservationStatus, string> = {
  none: "No reservation",
  tentative: "Tentative",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
};

function artifactLabel(mediaType: string): string {
  if (mediaType === "application/pdf") return "PDF attachment";
  if (mediaType === "image/jpeg") return "JPEG image";
  if (mediaType === "image/png") return "PNG image";
  if (mediaType === "image/webp") return "WebP image";
  return "Private attachment";
}

export function ReservationSummary({ reservation, compact = false }: {
  reservation: Reservation;
  compact?: boolean;
}) {
  if (reservation.status === "none") return null;
  const risk = cancellationRisk(reservation);
  const statusStyle = reservation.status === "confirmed"
    ? "bg-[#DCEAD4] text-[#46613D]"
    : reservation.status === "tentative"
      ? "bg-[#F5E6C8] text-[#8A6D1F]"
      : "bg-[#E5DED2] text-[#756B5E]";
  const riskStyle = risk?.level === "expired" || risk?.level === "urgent"
    ? "border-[#E8B4A2] bg-[#FFF1EC] text-[#9D3514]"
    : risk?.level === "soon"
      ? "border-[#E5D39E] bg-[#FFF9E8] text-[#7D6418]"
      : "border-[#C9D8BF] bg-[#F4F8F1] text-[#46613D]";

  return (
    <div className={`${compact ? "mt-2" : "mt-3 rounded-xl border border-[#EADFCC] bg-[#F7F0E5] p-3"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusStyle}`}>
          {reservation.status === "confirmed" ? "✓ " : ""}{STATUS_LABEL[reservation.status]} reservation
        </span>
        {["tentative", "confirmed"].includes(reservation.status) && (
          <span className="text-xs font-medium text-[#8A6D1F]">
            🔒 {reservation.status === "confirmed" ? "Protected" : "Held"} from replanning
          </span>
        )}
      </div>
      {reservation.reservationAt && (
        <p className="mt-1 text-sm font-semibold text-[#2D2A24]">
          {formatReservationDate(reservation.reservationAt)}
        </p>
      )}
      {!compact && reservation.confirmationNumber && (
        <p className="mt-1 text-sm text-[#756B5E]">
          Confirmation: <span className="font-mono text-[#2D2A24]">{reservation.confirmationNumber}</span>
        </p>
      )}
      {risk && (
        <p className={`mt-2 rounded-lg border px-2 py-1 text-xs font-semibold ${riskStyle}`}>{risk.message}</p>
      )}
      {!compact && reservation.bookingUrl && (
        <a
          href={reservation.bookingUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-sm font-semibold text-[#C2571B] hover:underline"
        >
          Open booking ↗
        </a>
      )}
    </div>
  );
}

export default function ReservationDetails({
  reservation,
  isOrganizer,
  busy,
  onSave,
  onUploadArtifact,
  onRemoveArtifact,
  onDownloadArtifact,
  onRetryArtifactCleanup,
}: {
  reservation: Reservation;
  isOrganizer: boolean;
  busy: boolean;
  onSave: (reservation: Omit<Reservation, "autoLocked" | "artifact" | "organizerVerifiedAt"> & { organizerVerified: boolean }) => Promise<boolean>;
  onUploadArtifact: (file: File) => Promise<boolean>;
  onRemoveArtifact: () => Promise<void>;
  onDownloadArtifact: () => Promise<void>;
  onRetryArtifactCleanup: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<ReservationStatus>(reservation.status === "none" ? "tentative" : reservation.status);
  const [reservationAt, setReservationAt] = useState(toDateTimeLocalValue(reservation.reservationAt));
  const [confirmationNumber, setConfirmationNumber] = useState(reservation.confirmationNumber ?? "");
  const [bookingUrl, setBookingUrl] = useState(reservation.bookingUrl ?? "");
  const [cancellationDeadline, setCancellationDeadline] = useState(
    toDateTimeLocalValue(reservation.cancellationDeadline),
  );
  const [detailsSource, setDetailsSource] = useState<"organizer" | "artifact">(reservation.detailsSource ?? "organizer");
  const [organizerVerified, setOrganizerVerified] = useState(Boolean(reservation.organizerVerifiedAt));

  function beginEditing() {
    setStatus(reservation.status === "none" ? "tentative" : reservation.status);
    setReservationAt(toDateTimeLocalValue(reservation.reservationAt));
    setConfirmationNumber(reservation.confirmationNumber ?? "");
    setBookingUrl(reservation.bookingUrl ?? "");
    setCancellationDeadline(toDateTimeLocalValue(reservation.cancellationDeadline));
    setDetailsSource(reservation.detailsSource ?? "organizer");
    setOrganizerVerified(Boolean(reservation.organizerVerifiedAt));
    setEditing(true);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await onSave({
      status,
      reservationAt: status === "none" ? null : fromDateTimeLocalValue(reservationAt),
      confirmationNumber: status === "none" ? null : confirmationNumber.trim() || null,
      bookingUrl: status === "none" ? null : bookingUrl.trim() || null,
      cancellationDeadline: status === "none" ? null : fromDateTimeLocalValue(cancellationDeadline),
      detailsSource: status === "none" ? "organizer" : detailsSource,
      organizerVerified: status === "none" ? false : organizerVerified,
    });
    if (saved) setEditing(false);
  }

  return (
    <div>
      <ReservationSummary reservation={reservation} />
      {isOrganizer && !editing && (
        <button
          onClick={beginEditing}
          className="mt-2 rounded-full border border-[#D9C49E] px-3 py-1 text-sm text-[#8A6D1F] transition hover:bg-[#F5E6C8]"
        >
          {reservation.status === "none" ? "+ Add reservation" : "Edit reservation"}
        </button>
      )}
      {reservation.artifact && (
        <div className="mt-2 rounded-xl border border-[#E5D39E] bg-[#FFF9E8] p-3 text-sm">
          <p className="font-semibold text-[#7D6418]">Reservation proof · private</p>
          <p className="mt-1 text-[#756B5E]">
            {reservation.artifact.fileName ?? artifactLabel(reservation.artifact.mediaType)} · {Math.ceil(reservation.artifact.byteSize / 1024)} KB · uploaded by {reservation.artifact.uploadedByName}
          </p>
          <p className="mt-1 text-xs font-semibold text-[#9D3514]">
            {reservation.organizerVerifiedAt
              ? "Organizer verified the reservation details."
              : "Unverified evidence — the file does not prove who made the booking or that its details are correct."}
          </p>
          {isOrganizer && (
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => void onDownloadArtifact()} disabled={busy} className="font-semibold text-[#C2571B] hover:underline disabled:opacity-50">Download</button>
              <button type="button" onClick={() => void onRemoveArtifact()} disabled={busy} className="font-semibold text-[#9D3514] hover:underline disabled:opacity-50">Remove</button>
            </div>
          )}
        </div>
      )}
      {isOrganizer && reservation.artifactCleanupPending && (
        <div className="mt-2 rounded-xl border border-[#E8B4A2] bg-[#FFF1EC] p-3 text-xs text-[#9D3514]">
          <p className="font-semibold">Private proof cleanup is queued and remains auditable.</p>
          <button type="button" onClick={() => void onRetryArtifactCleanup()} disabled={busy} className="mt-1 font-semibold underline disabled:opacity-50">
            Retry cleanup
          </button>
        </div>
      )}
      {isOrganizer && (
        <label className="mt-2 block text-sm font-semibold text-[#8A6D1F]">
          {reservation.artifact ? "Replace proof" : "Attach reservation proof"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            disabled={busy}
            className="mt-1 block w-full text-xs font-normal text-[#756B5E] file:mr-2 file:rounded-full file:border-0 file:bg-[#F5E6C8] file:px-3 file:py-1 file:font-semibold file:text-[#8A6D1F]"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onUploadArtifact(file).then(() => { event.target.value = ""; });
            }}
          />
          <span className="mt-1 block text-xs font-normal">JPG, PNG, WebP, or PDF up to 8 MB. Stored privately; only the organizer can download it.</span>
        </label>
      )}
      {editing && (
        <form onSubmit={submit} className="mt-3 grid gap-3 rounded-xl border border-[#D9C49E] bg-[#FFF8EA] p-3 sm:grid-cols-2">
          <label className="text-sm text-[#2D2A24]">
            Status
            <select value={status} onChange={(event) => setStatus(event.target.value as ReservationStatus)} className="mt-1 w-full rounded-lg border border-[#EADFCC] bg-white px-3 py-2">
              <option value="tentative">Tentative</option>
              <option value="confirmed">Confirmed</option>
              <option value="cancelled">Cancelled</option>
              <option value="none">Remove reservation</option>
            </select>
          </label>
          <label className="text-sm text-[#2D2A24]">
            Reservation date and time
            <input type="datetime-local" value={reservationAt} onChange={(event) => setReservationAt(event.target.value)} required={status === "confirmed"} disabled={status === "none"} className="mt-1 w-full rounded-lg border border-[#EADFCC] bg-white px-3 py-2 disabled:opacity-50" />
          </label>
          <label className="text-sm text-[#2D2A24]">
            Confirmation number
            <input value={confirmationNumber} onChange={(event) => setConfirmationNumber(event.target.value)} maxLength={120} disabled={status === "none"} className="mt-1 w-full rounded-lg border border-[#EADFCC] bg-white px-3 py-2 disabled:opacity-50" />
          </label>
          <label className="text-sm text-[#2D2A24]">
            Booking link
            <input type="url" value={bookingUrl} onChange={(event) => setBookingUrl(event.target.value)} placeholder="https://…" disabled={status === "none"} className="mt-1 w-full rounded-lg border border-[#EADFCC] bg-white px-3 py-2 disabled:opacity-50" />
          </label>
          <label className="text-sm text-[#2D2A24] sm:col-span-2">
            Cancellation deadline
            <input type="datetime-local" value={cancellationDeadline} onChange={(event) => setCancellationDeadline(event.target.value)} disabled={status === "none"} className="mt-1 w-full rounded-lg border border-[#EADFCC] bg-white px-3 py-2 disabled:opacity-50" />
          </label>
          {reservation.artifact && status !== "none" && (
            <label className="text-sm text-[#2D2A24] sm:col-span-2">
              Detail provenance
              <select value={detailsSource} onChange={(event) => setDetailsSource(event.target.value as "organizer" | "artifact")} className="mt-1 w-full rounded-lg border border-[#EADFCC] bg-white px-3 py-2">
                <option value="organizer">Entered from organizer knowledge</option>
                <option value="artifact">Transcribed from attached proof (unverified)</option>
              </select>
            </label>
          )}
          {status === "confirmed" && !confirmationNumber.trim() && (
            <label className="flex items-start gap-2 text-sm text-[#2D2A24] sm:col-span-2">
              <input type="checkbox" checked={organizerVerified} onChange={(event) => setOrganizerVerified(event.target.checked)} className="mt-1" />
              <span>I have manually verified this reservation. The attachment alone is not confirmation and does not imply the assistant booked it.</span>
            </label>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <button type="submit" disabled={busy} className="rounded-full bg-[#C2571B] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {busy ? "Saving…" : "Save reservation"}
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={busy} className="rounded-full border border-[#EADFCC] px-4 py-2 text-sm text-[#756B5E]">
              Cancel
            </button>
          </div>
          {["tentative", "confirmed"].includes(status) && (
            <p className="text-xs text-[#8A6D1F] sm:col-span-2">Active reservations are locked automatically and cannot be regenerated, reshuffled, swapped, or skipped.</p>
          )}
        </form>
      )}
    </div>
  );
}
