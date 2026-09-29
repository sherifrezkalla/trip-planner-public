# Organizer Alerts Architecture

## Goal

Tell the organizer, on their phone, that the group needs them — and let them
answer without opening the app.

The [group change protocol](group-change-protocol.md) shipped without this, and
that undercut it. The protocol exists so a group is not blocked by an absent
organizer, but with no notification the organizer is exactly the person who has
to keep checking. The second gap was quieter and mattered as much: a group vote
can change the plan at more than half agreement, so the plan could move while
the organizer slept and nothing said so.

## Why Telegram

**There is no address to notify anyone at.** The `travelers` table holds a
display name, a token, and preferences — no email, no phone. Joining from a link
with no account is the product's selling point, and collecting contact details
to fix notifications would trade away the thing people like for the thing they
occasionally need.

A Telegram chat id is not contact detail in that sense. Telegram issues it, it
is useless to anyone but this bot, and it exists only because the organizer went
and started a conversation.

The alternatives were rejected on the facts:

- **Web Push** needs a service worker, manifest, VAPID keys and a subscription
  lifecycle this app has none of, and on iOS it requires the site be added to the
  Home Screen before push works at all — a barrier in front of the one person who
  needs it.
- **Email** cannot honestly meet "within minutes"; it gets buried. It also needs
  an address stored and a sending service.

The cost of the choice is recorded under limitations: it only works for people
who use Telegram.

## Linking

`organizer_telegram_links` holds one row per trip. A `CHECK` constraint permits
exactly two states, so a half-linked row cannot exist:

| State | `link_code` | `chat_id` | `linked_at` |
|---|---|---|---|
| pending | set | null | null |
| linked | null | set | set |

The organizer taps **Get Telegram alerts**; the server mints a single-use code
with a one-hour expiry and returns a `t.me` link. Opening it delivers
`/start <code>` to the webhook, which stores the chat id and clears the code in
the same update — that clearing is what makes the code single-use, so a leaked
link cannot be replayed.

Re-linking replaces the row rather than adding one, so an organizer who changes
phone is never competing with their own stale chat.

## Messages

| Trigger | Buttons |
|---|---|
| A request opened | Approve, Turn down |
| The group applied one by vote | none — it is already done |
| A request cancelled itself | none |

The organizer is never told about the consequences of their own actions. Being
notified of your own tap is noise, and noise is how a channel stops being read.

Wording lives in `lib/telegram-messages.ts`, which is pure, so what is worth
waking someone for is decided separately from the mechanics of sending it.

Messages are plain text with **no parse mode**. Venue names come from Google and
notes are written by travellers; markup would need escaping that, done wrong,
either mangles a name or drops the message entirely. Bold is not worth that.

## Acting from the message

`POST /api/telegram/webhook` handles `/start` and callback queries. It is public
by necessity — Telegram has to reach it — so the shared secret in
`X-Telegram-Bot-Api-Secret-Token` is the only thing between a stranger and the
ability to approve changes to somebody's trip. It is checked **before anything is
read or written**.

Authorisation for a button press is the linked chat: the proposal lookup is
scoped to the trip that chat is linked to, so a chat linked to one trip cannot
reach another trip's requests even with a valid id.

The press then calls the same `settleProposal` as the board, not a second copy.
That is what keeps **staleness outranking the organizer**: approving a request
whose destination filled yesterday cancels it and reports why, rather than
forcing a write nobody would want. The message is then edited in place, so the
buttons cannot be pressed twice from chat history.

## Failure handling

Every Telegram call is best-effort and swallowed. A Telegram outage must never
fail a request a traveller is making: a missed alert is an inconvenience, a
traveller who cannot ask for a change is a broken product. An unlinked trip skips
silently, which is the normal case for most trips.

The bot token and webhook secret are never logged.

## Setup

`scripts/setup-telegram.sh` asks for the bot key with hidden input, checks it
against Telegram, and writes it plus a generated webhook secret to `.env.local`.
`scripts/register-telegram-webhook.sh` points the bot at the deployed URL and
confirms the result from Telegram's side.

Both are needed, and neither works against localhost: Telegram only accepts an
HTTPS webhook, so the alert path cannot be exercised until it is deployed.

## Limitations

- Requires the organizer to use Telegram. No fallback.
- **Organizer only.** Opting travellers in is what would let group votes fire
  without the organizer at all, but it pushes a setup step onto people who did
  not ask for it. Deliberately deferred until this is proven for one person.
- Travellers are not told their own request was decided; they see it in the app.
- No digests and no quiet hours. One person and three event types — batching
  solves a problem this does not have yet.
- A proposal is alerted on when it opens and when it settles, but not when it is
  close to carrying, so there is no nudge before a vote tips.
