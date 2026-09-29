import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReservationAssistance from "@/components/ReservationAssistance";
import type { ReservationAttempt } from "@/lib/reservation-assistance";

describe("reservation draft review", () => {
  it("tells the organizer to supply missing contacts on the external site", () => {
    const html = renderToStaticMarkup(createElement(ReservationAssistance, {
      itemId: "item", slug: "trip", token: "token", venueName: "Museum", onChanged: () => {},
      attempt: { id: "attempt", state: "awaiting_approval", partySize: 4, requestedAt: "2026-10-01T18:00:00Z", bookingName: "Organizer",
        contactEmail: null, contactPhone: null, routes: ["https://maps.test"], routeIndex: 0, alternatives: [] } as unknown as ReservationAttempt,
    }));
    expect(html).toContain("Contact details will be supplied on the external site.");
    expect(html).toContain("Nothing has been booked.");
    expect(html).not.toContain("undefined");
  });
});
