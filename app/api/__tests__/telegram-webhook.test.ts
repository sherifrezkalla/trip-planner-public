import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  edit: vi.fn(),
  answer: vi.fn(),
  settle: vi.fn(),
  summary: vi.fn(),
  broadcast: vi.fn(),
  rows: {} as Record<string, unknown>,
  updates: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/telegram", () => ({
  sendMessage: mocks.send,
  editMessage: mocks.edit,
  answerCallback: mocks.answer,
}));
vi.mock("@/lib/proposal-actions", () => ({ settleProposal: mocks.settle }));
vi.mock("@/lib/organizer-alerts", () => ({ proposalSummary: mocks.summary }));
vi.mock("@/lib/realtime", () => ({ broadcastTripUpdate: mocks.broadcast }));
vi.mock("@/lib/db", () => ({
  serviceClient: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const key of ["select", "eq", "is", "not"]) q[key] = () => q;
      q.update = (values: Record<string, unknown>) => {
        mocks.updates.push({ table, ...values });
        return q;
      };
      q.delete = () => q;
      q.maybeSingle = () => Promise.resolve({ data: mocks.rows[table] ?? null, error: null });
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: mocks.rows[table] ?? null, error: null }).then(resolve);
      return q;
    },
  }),
}));

import { POST as webhook } from "@/app/api/telegram/webhook/route";

const SECRET = "test-webhook-secret";

function update(body: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  return new Request("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const callback = {
  callback_query: {
    id: "cb1",
    data: "approve:prop-1",
    message: { chat: { id: 555 }, message_id: 9 },
  },
};

describe("telegram webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    mocks.rows = {};
    mocks.updates = [];
    mocks.send.mockResolvedValue({ messageId: 1 });
    mocks.edit.mockResolvedValue(undefined);
    mocks.answer.mockResolvedValue(undefined);
    mocks.broadcast.mockResolvedValue(undefined);
    mocks.summary.mockResolvedValue({
      proposalId: "prop-1",
      kind: "move",
      venueName: "Grama Bay",
      proposedByName: "Nancy",
      note: "",
      fromDayIndex: 11,
      fromBlock: "afternoon",
      toDayIndex: 11,
      toBlock: "evening",
    });
  });

  describe("the secret header", () => {
    it("refuses an update with the wrong secret", async () => {
      const res = await webhook(update(callback, "not-the-secret"));

      expect(res.status).toBe(401);
      expect(mocks.settle).not.toHaveBeenCalled();
    });

    it("refuses an update with no secret at all", async () => {
      const res = await webhook(update(callback, null));

      expect(res.status).toBe(401);
      expect(mocks.settle).not.toHaveBeenCalled();
    });
  });

  describe("linking with /start", () => {
    it("stores the chat id and confirms which trip", async () => {
      mocks.rows.organizer_telegram_links = {
        id: "link-1",
        trip_id: "trip-1",
        code_expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
      mocks.rows.trips = { title: "Example Region 2026", destination_name: "Vlorë" };

      await webhook(update({ message: { chat: { id: 555 }, text: "/start abc123" } }));

      expect(mocks.updates[0]).toMatchObject({
        table: "organizer_telegram_links",
        chat_id: 555,
        link_code: null,
      });
      expect(mocks.send.mock.calls[0][0].text).toContain("Linked to Example Region 2026.");
    });

    it("refuses an expired code without linking anything", async () => {
      mocks.rows.organizer_telegram_links = {
        id: "link-1",
        trip_id: "trip-1",
        code_expires_at: new Date(Date.now() - 60_000).toISOString(),
      };

      await webhook(update({ message: { chat: { id: 555 }, text: "/start stale" } }));

      expect(mocks.updates).toHaveLength(0);
      expect(mocks.send.mock.calls[0][0].text).toContain("expired or was already used");
    });

    it("refuses an unknown code", async () => {
      mocks.rows.organizer_telegram_links = null;

      await webhook(update({ message: { chat: { id: 555 }, text: "/start nope" } }));

      expect(mocks.updates).toHaveLength(0);
      expect(mocks.send).toHaveBeenCalled();
    });
  });

  describe("pressing a button", () => {
    beforeEach(() => {
      mocks.rows.organizer_telegram_links = { trip_id: "trip-1", traveler_id: "organizer" };
      mocks.rows.plan_proposals = { id: "prop-1", trip_id: "trip-1", status: "open" };
      mocks.rows.trips = { slug: "trip-slug" };
    });

    it("approves as the linked organiser and rewrites the message", async () => {
      mocks.settle.mockResolvedValue({
        status: "applied",
        reason: "Approved by the organiser.",
        yes: 1,
        no: 0,
        needed: 5,
      });

      await webhook(update(callback));

      expect(mocks.settle.mock.calls[0][1]).toMatchObject({
        actorId: "organizer",
        force: "approve",
      });
      expect(mocks.edit.mock.calls[0][0].text).toContain("Approved by the organiser.");
      expect(mocks.broadcast).toHaveBeenCalledWith("trip-slug");
    });

    it("turns a request down", async () => {
      mocks.settle.mockResolvedValue({
        status: "rejected",
        reason: "Turned down by the organiser.",
        yes: 0,
        no: 0,
        needed: 5,
      });

      await webhook(update({
        callback_query: { ...callback.callback_query, data: "reject:prop-1" },
      }));

      expect(mocks.settle.mock.calls[0][1]).toMatchObject({ force: "reject" });
    });

    it("reports a stale request as cancelled rather than forcing it through", async () => {
      mocks.settle.mockResolvedValue({
        status: "cancelled",
        reason: "Cancelled — Day 12 lunch was filled.",
        yes: 1,
        no: 0,
        needed: 5,
      });

      await webhook(update(callback));

      expect(mocks.edit.mock.calls[0][0].text).toContain("Day 12 lunch was filled");
      expect(mocks.answer.mock.calls[0][0].text).toContain("stale");
    });

    it("refuses a chat that is not linked to any trip", async () => {
      mocks.rows.organizer_telegram_links = null;

      await webhook(update(callback));

      expect(mocks.settle).not.toHaveBeenCalled();
      expect(mocks.answer.mock.calls[0][0].text).toContain("not linked");
    });

    it("refuses a proposal that does not belong to the linked trip", async () => {
      // The lookup is scoped by trip_id, so a foreign proposal simply is not found.
      mocks.rows.plan_proposals = null;

      await webhook(update(callback));

      expect(mocks.settle).not.toHaveBeenCalled();
      expect(mocks.answer.mock.calls[0][0].text).toContain("not on your trip");
    });

    it("says so when the request was already decided elsewhere", async () => {
      mocks.rows.plan_proposals = { id: "prop-1", trip_id: "trip-1", status: "applied" };

      await webhook(update(callback));

      expect(mocks.settle).not.toHaveBeenCalled();
      expect(mocks.edit.mock.calls[0][0].text).toContain("already decided");
    });

    it("ignores callback data it does not recognise", async () => {
      await webhook(update({
        callback_query: { ...callback.callback_query, data: "delete-everything:prop-1" },
      }));

      expect(mocks.settle).not.toHaveBeenCalled();
    });
  });
});
