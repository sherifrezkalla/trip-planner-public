import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn(), settle: vi.fn() }));
vi.mock("@/lib/db", () => ({ serviceClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/auth", () => ({ authTraveler: mocks.auth }));
vi.mock("@/lib/proposal-actions", () => ({ settleProposal: mocks.settle }));
vi.mock("@/lib/realtime", () => ({ broadcastTripUpdate: vi.fn() }));
vi.mock("@/lib/organizer-alerts", () => ({ alertOrganizerInBackground: vi.fn() }));
import { POST as vote } from "@/app/api/proposals/[id]/vote/route";
import { POST as decide } from "@/app/api/proposals/[id]/decide/route";
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.mockResolvedValue({ trip: { id: "trip" }, me: { id: "bot", is_organizer: true, is_bot: true } });
});
describe("legacy malformed bot organizer", () => {
  it.each(["vote", "decide"])("cannot %s a proposal on the web", async operation => {
    const response = await (operation === "vote" ? vote : decide)(new Request("https://trip.test", { method: "POST", body: JSON.stringify({ slug: "trip", token: "secret", ...(operation === "vote" ? { value: 1 } : { decision: "approve" }) }) }), { params: Promise.resolve({ id: "proposal" }) });
    expect(response.status).toBe(403); expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.settle).not.toHaveBeenCalled();
  });
});
