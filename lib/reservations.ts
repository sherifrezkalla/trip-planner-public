export const RESERVATION_STATUSES = ["none", "tentative", "confirmed", "cancelled"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export type ReservationDetails = {
  status: ReservationStatus;
  reservationAt: string | null;
  confirmationNumber: string | null;
  bookingUrl: string | null;
  cancellationDeadline: string | null;
  autoLocked: boolean;
  detailsSource?: "organizer" | "artifact";
  organizerVerifiedAt?: string | null;
  artifact?: ReservationArtifact | null;
  artifactCleanupPending?: boolean;
};

export type ReservationArtifact = {
  id: string;
  fileName?: string;
  mediaType: string;
  byteSize: number;
  uploadedAt: string;
  uploadedByName: string;
};

export function confirmationIsGrounded(input: {
  status: ReservationStatus;
  confirmationNumber: string | null;
  organizerVerified: boolean;
}): boolean {
  return input.status !== "confirmed" || Boolean(input.confirmationNumber?.trim()) || input.organizerVerified;
}

export type CancellationRisk = {
  level: "expired" | "urgent" | "soon" | "later";
  message: string;
};

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatReservationDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? DATE_TIME_FORMATTER.format(date) : "Date unavailable";
}

export function cancellationRisk(
  reservation: Pick<ReservationDetails, "status" | "cancellationDeadline">,
  now = new Date(),
): CancellationRisk | null {
  if (
    !reservation.cancellationDeadline
    || !["tentative", "confirmed"].includes(reservation.status)
  ) return null;

  const deadline = new Date(reservation.cancellationDeadline);
  if (!Number.isFinite(deadline.getTime())) return null;
  const minutes = Math.ceil((deadline.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) {
    return { level: "expired", message: "Cancellation deadline has passed" };
  }
  if (minutes <= 24 * 60) {
    const hours = Math.max(1, Math.ceil(minutes / 60));
    return { level: "urgent", message: `Cancellation deadline in ${hours} ${hours === 1 ? "hour" : "hours"}` };
  }
  if (minutes <= 72 * 60) {
    const days = Math.ceil(minutes / (24 * 60));
    return { level: "soon", message: `Cancellation deadline in ${days} days` };
  }
  return { level: "later", message: `Cancel by ${formatReservationDate(reservation.cancellationDeadline)}` };
}

export function toDateTimeLocalValue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function fromDateTimeLocalValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
