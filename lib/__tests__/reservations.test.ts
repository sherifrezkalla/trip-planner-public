import { describe, expect, it } from "vitest";
import {
  cancellationRisk,
  formatReservationDate,
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
  confirmationIsGrounded,
} from "@/lib/reservations";

describe("reservation reliability", () => {
  it("escalates a cancellation deadline inside 24 hours", () => {
    expect(cancellationRisk({
      status: "confirmed",
      cancellationDeadline: "2026-08-14T10:00:00.000Z",
    }, new Date("2026-08-13T12:00:00.000Z"))).toEqual({
      level: "urgent",
      message: "Cancellation deadline in 22 hours",
    });
  });

  it("marks passed deadlines and ignores cancelled bookings", () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    expect(cancellationRisk({
      status: "tentative",
      cancellationDeadline: "2026-08-13T11:59:00.000Z",
    }, now)).toEqual({ level: "expired", message: "Cancellation deadline has passed" });
    expect(cancellationRisk({
      status: "cancelled",
      cancellationDeadline: "2026-08-13T11:59:00.000Z",
    }, now)).toBeNull();
  });

  it("round-trips a browser-local date value through an ISO timestamp", () => {
    const iso = fromDateTimeLocalValue("2026-08-20T19:30");
    expect(iso).not.toBeNull();
    expect(toDateTimeLocalValue(iso)).toBe("2026-08-20T19:30");
  });

  it("formats valid booking dates and handles corrupt values", () => {
    expect(formatReservationDate("not-a-date")).toBe("Date unavailable");
    expect(formatReservationDate("2026-08-20T19:30:00.000Z")).not.toBe("Date unavailable");
  });

  it("never treats evidence alone as confirmation", () => {
    expect(confirmationIsGrounded({ status: "confirmed", confirmationNumber: null, organizerVerified: false })).toBe(false);
    expect(confirmationIsGrounded({ status: "confirmed", confirmationNumber: " REF-1 ", organizerVerified: false })).toBe(true);
    expect(confirmationIsGrounded({ status: "confirmed", confirmationNumber: null, organizerVerified: true })).toBe(true);
  });
});
