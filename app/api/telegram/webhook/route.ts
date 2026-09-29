import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/db";
import { settleProposal, type ProposalRow } from "@/lib/proposal-actions";
import { proposalSummary } from "@/lib/organizer-alerts";
import { answerCallback, editMessage, sendMessage } from "@/lib/telegram";
import { LINK_CODE_REJECTED, decidedMessage, linkedMessage } from "@/lib/telegram-messages";
import { broadcastTripUpdate } from "@/lib/realtime";

/**
 * Everything Telegram sends us: /start when an organizer links, and callback
 * queries when they press Approve or Turn down.
 *
 * This endpoint is public by necessity — Telegram has to reach it — so the
 * shared secret header is the only thing standing between a stranger and the
 * ability to approve changes to somebody's trip. It is checked before anything
 * is read, let alone written.
 */

const PROPOSAL_SELECT =
  "id, trip_id, item_id, proposed_by, kind, from_day_index, from_block, to_day_index, to_block, to_candidate_id, suggestion_text, note, status";

type Update = {
  message?: { chat: { id: number }; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
};

export async function POST(req: Request): Promise<NextResponse> {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return NextResponse.json({ ok: true });

  if (req.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const update = (await req.json().catch(() => null)) as Update | null;
  if (!update) return NextResponse.json({ ok: true });

  // Telegram retries anything that is not a 2xx, so failures below are
  // swallowed deliberately: a message we cannot handle should be dropped, not
  // redelivered forever.
  try {
    if (update.message?.text?.startsWith("/start")) {
      await handleStart(update.message.chat.id, update.message.text);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch {
    // Intentionally silent — see above.
  }

  return NextResponse.json({ ok: true });
}

async function handleStart(chatId: number, text: string): Promise<void> {
  const code = text.split(/\s+/)[1] ?? "";
  const db = serviceClient();

  if (!code) {
    await sendMessage({ chatId, text: LINK_CODE_REJECTED });
    return;
  }

  const { data: link } = await db
    .from("organizer_telegram_links")
    .select("id, trip_id, code_expires_at")
    .eq("link_code", code)
    .maybeSingle();

  const expired =
    !link || !link.code_expires_at || new Date(link.code_expires_at as string) < new Date();
  if (expired) {
    await sendMessage({ chatId, text: LINK_CODE_REJECTED });
    return;
  }

  // Clearing the code as we store the chat id is what makes it single-use.
  const { error } = await db
    .from("organizer_telegram_links")
    .update({ chat_id: chatId, link_code: null, code_expires_at: null, linked_at: new Date().toISOString() })
    .eq("id", link.id)
    .is("chat_id", null);
  if (error) {
    await sendMessage({ chatId, text: LINK_CODE_REJECTED });
    return;
  }

  const { data: trip } = await db
    .from("trips")
    .select("title, destination_name")
    .eq("id", link.trip_id)
    .maybeSingle();

  const name = (trip?.title as string) || (trip?.destination_name as string) || "your trip";
  await sendMessage({ chatId, text: linkedMessage(name) });
}

async function handleCallback(query: NonNullable<Update["callback_query"]>): Promise<void> {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const [action, proposalId] = (query.data ?? "").split(":");

  if (!chatId || !messageId || (action !== "approve" && action !== "reject") || !proposalId) {
    await answerCallback({ callbackQueryId: query.id });
    return;
  }

  const db = serviceClient();

  const { data: link } = await db
    .from("organizer_telegram_links")
    .select("trip_id, traveler_id")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (!link) {
    await answerCallback({ callbackQueryId: query.id, text: "This chat is not linked to a trip." });
    return;
  }

  const { data: proposal } = await db
    .from("plan_proposals")
    .select(PROPOSAL_SELECT)
    .eq("id", proposalId)
    .eq("trip_id", link.trip_id)
    .maybeSingle();

  // Scoping the lookup to the linked trip is the authorisation check: a chat
  // linked to one trip cannot reach another trip's proposals even with a
  // valid id.
  if (!proposal) {
    await answerCallback({ callbackQueryId: query.id, text: "That request is not on your trip." });
    return;
  }

  const summary = await proposalSummary(db, proposalId);

  if (proposal.status !== "open") {
    await answerCallback({ callbackQueryId: query.id, text: "Already decided." });
    if (summary) {
      await editMessage({
        chatId,
        messageId,
        text: decidedMessage(summary, "This was already decided elsewhere."),
      });
    }
    return;
  }

  const result = await settleProposal(db, {
    proposal: proposal as unknown as ProposalRow,
    actorId: link.traveler_id,
    force: action,
  });

  await answerCallback({ callbackQueryId: query.id, text: outcomeToast(result.status) });
  if (summary) {
    await editMessage({ chatId, messageId, text: decidedMessage(summary, result.reason) });
  }

  const { data: trip } = await db
    .from("trips")
    .select("slug")
    .eq("id", link.trip_id)
    .maybeSingle();
  if (trip?.slug) await broadcastTripUpdate(trip.slug as string).catch(() => {});
}

function outcomeToast(status: string): string {
  if (status === "applied") return "Applied.";
  if (status === "rejected") return "Turned down.";
  if (status === "cancelled") return "Cancelled — it went stale.";
  return "Done.";
}
