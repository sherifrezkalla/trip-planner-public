/**
 * The Telegram Bot API, kept to the three calls this app makes.
 *
 * Every function here is best-effort. A trip must never fail because Telegram
 * is unreachable — the organizer missing a message is an inconvenience, a
 * traveller unable to file a request is a broken product. Callers treat these
 * the way they treat broadcastTripUpdate: fire, and carry on.
 */

import type { TelegramButton } from "./telegram-messages";

const API = "https://api.telegram.org";

function botToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  return token;
}

/** Whether alerts are configured at all. Lets callers skip silently. */
export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

export function botUsername(): string {
  return process.env.TELEGRAM_BOT_USERNAME ?? "";
}

/** The one-time link an organizer opens to attach their Telegram account. */
export function botStartUrl(code: string): string {
  return `https://t.me/${botUsername()}?start=${encodeURIComponent(code)}`;
}

async function call(
  method: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(`${API}/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => null)) as
    | { ok?: boolean; description?: string; result?: unknown }
    | null;
  if (!res.ok || !payload?.ok) {
    // The token would otherwise be one careless template literal from a log.
    throw new Error(`telegram ${method} failed: ${payload?.description ?? res.status}`);
  }
  return payload.result;
}

function keyboard(buttons: TelegramButton[]) {
  if (buttons.length === 0) return undefined;
  return {
    inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.callbackData }))],
  };
}

export async function sendMessage(
  args: { chatId: number; text: string; buttons?: TelegramButton[] },
  fetchImpl: typeof fetch = fetch,
): Promise<{ messageId: number }> {
  const result = (await call(
    "sendMessage",
    {
      chat_id: args.chatId,
      text: args.text,
      reply_markup: keyboard(args.buttons ?? []),
    },
    fetchImpl,
  )) as { message_id: number };
  return { messageId: result.message_id };
}

/**
 * Replace a message after its buttons have been used.
 *
 * Editing rather than replying is what stops a second tap: the buttons are gone
 * from the chat, so the stale request cannot be approved twice from history.
 */
export async function editMessage(
  args: { chatId: number; messageId: number; text: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await call(
    "editMessageText",
    { chat_id: args.chatId, message_id: args.messageId, text: args.text },
    fetchImpl,
  );
}

/** Clears the spinner on a tapped button. Telegram expects this promptly. */
export async function answerCallback(
  args: { callbackQueryId: string; text?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await call(
    "answerCallbackQuery",
    { callback_query_id: args.callbackQueryId, text: args.text },
    fetchImpl,
  );
}
