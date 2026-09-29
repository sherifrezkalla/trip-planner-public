# Organiser Telegram Alerts — Design

Date: 2026-08-16
Status: approved for planning

## Problem

The group change protocol shipped without any way to tell the organiser a
request is waiting. A pending request is found only by opening the app.

That is the weak point of the protocol. It was built so a group standing in the
street could adjust the plan without waiting on an organiser who is asleep or
offline — but with no notification, the organiser is exactly the person who has
to keep checking.

The second, quieter gap matters as much: with a group vote able to apply a
change at more than half agreement, the plan can change while the organiser is
asleep and nothing tells them. The organiser asked for a view of the plan; a
silent apply is the opposite of one.

## Constraint that shapes everything

**There is no address to notify anyone at.** The `travelers` table holds
`display_name`, `token`, `interests`, `pace`, `dietary`, `constraints_note` —
no email, no phone. Joining from a link with no account is the product's
selling point, and collecting contact details to fix notifications would trade
away the thing people like for the thing they only sometimes need.

There is also no service worker, no manifest, and no PWA, so browser Web Push
would have to be built from nothing. On iOS it additionally requires the site be
added to the Home Screen before push works at all.

Slack is disabled across all of this user's workflows.

## Decisions

| Question | Decision |
|---|---|
| How fast | Within minutes, with the app closed |
| Who | Organiser only |
| Channel | Telegram bot, `@TripPlannerAlertsBot` |
| Credentials | Its own bot, never shared with any other system |
| Can the organiser act from the message | Yes — Approve and Turn down as inline buttons |
| Which events | New request; group applied one without them; request cancelled as stale |

Telegram was chosen over Web Push and email. Web Push needs a service worker,
manifest, VAPID keys, and subscription lifecycle this app has none of, and its
iOS Home Screen requirement puts a barrier in front of the one person who needs
it. Email cannot honestly meet "within minutes" — it gets buried. Telegram
costs nothing per message, pushes reliably to a locked phone, and needs one
setup step performed once by one person.

Its real limitation is recorded below: it only works for people who use
Telegram. That is acceptable while the audience is the organiser alone, and is
the reason this design does not extend to all travelers.

## Linking

New table `organizer_telegram_links`:

| Column | Notes |
|---|---|
| `id` | uuid |
| `trip_id` | references `trips`, cascade |
| `traveler_id` | references `travelers`, cascade |
| `chat_id` | bigint, null until `/start` arrives |
| `link_code` | unique, single-use |
| `code_expires_at` | one hour after issue |
| `linked_at` | null until linked |
| `created_at` | |

One active link per trip.

Flow:

1. Organiser taps **Get Telegram alerts** on the board.
2. `POST /api/trips/[slug]/telegram/link` creates a row with a random
   `link_code` and returns `https://t.me/<TELEGRAM_BOT_USERNAME>?start=<code>`.
3. Organiser opens the link; Telegram delivers `/start <code>` to the webhook.
4. The webhook matches the code, stores `chat_id`, sets `linked_at`, clears the
   code, and replies confirming which trip is linked.

An expired or already-used code gets a plain refusal, not a silent failure.

No contact detail is collected or stored. A Telegram `chat_id` is an opaque
identifier that Telegram issues, so the no-accounts property survives.

## Messages

| Trigger | Content | Buttons |
|---|---|---|
| Request opened | who asked, what they want, their note, current tally | Approve, Turn down |
| Applied by group vote | what changed and the count that carried it | none — it is done |
| Cancelled as stale | what died and the stated reason | none |

The organiser is never notified of the consequences of their own actions.

Message building is pure and lives in `lib/telegram-messages.ts` so it can be
tested without a network.

## Acting from the message

Buttons carry callback data `approve:<proposalId>` and `reject:<proposalId>`.

`POST /api/telegram/webhook` handles both `/start` and callback queries. For a
callback it:

1. verifies the `X-Telegram-Bot-Api-Secret-Token` header against
   `TELEGRAM_WEBHOOK_SECRET`, rejecting anything else with 401;
2. looks up the link by `chat_id`;
3. confirms that traveler is the organiser of the trip owning the proposal;
4. calls the existing `settleProposal` with `force: "approve" | "reject"`;
5. edits the original message in place to show the outcome.

Step 4 is the important one. Reusing `settleProposal` means the Telegram path
obeys the same rules as the web UI rather than a second, weaker copy — in
particular **staleness still outranks the organiser**. Approving a request whose
destination filled yesterday cancels it and reports why. Editing the message in
place also stops a second tap doing anything.

## Failure handling

- Telegram calls are fire-and-forget with `.catch(() => {})`, the same
  treatment `broadcastTripUpdate` already gets. A Telegram outage must never
  fail a request a traveler is making.
- An unlinked trip skips notification silently.
- A callback for an already-decided proposal edits the message to say so rather
  than erroring at the user.
- The bot token and webhook secret are never logged.

## Testing

Pure message formatters get unit tests. The webhook gets tests for:

- valid `/start` links the chat
- expired or reused code is refused
- callback approve applies, callback reject closes
- **missing or wrong secret header returns 401**
- **callback from a chat that is not the trip's organiser is refused**
- callback on an already-decided proposal reports that instead of erroring
- a stale proposal approved from Telegram cancels with its reason

Notification dispatch is tested for firing on the right events, skipping the
actor's own actions, and skipping when unlinked.

## Environment

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, set
locally by `scripts/setup-telegram.sh`. The same three must be added to Vercel
production, and the webhook registered with Telegram against the production URL
once the endpoint is deployed. Neither works from localhost.

## Explicit non-goals

- Travelers other than the organiser. Everyone opting in would make group votes
  fire without the organiser at all, but it multiplies the setup step across
  people who did not ask for it. Revisit once this is proven for one person.
- Any notification channel that requires storing an email or phone number.
- Digests, quiet hours, or per-event preferences. One person, three event types;
  batching is a solution to a problem this does not have yet.

## Known limitations

- Requires the organiser to use Telegram. No fallback if they do not.
- A trip whose organiser never links simply behaves as it does today.
- Nothing notifies travelers that their own request was decided; they see it in
  the app.
- The bot cannot be reached from localhost, so end-to-end verification requires
  a deployed environment.
