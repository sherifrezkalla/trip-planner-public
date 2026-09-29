# Trip AI privacy notice — v1

Send this exact notice in the connected group, replacing only `<organizer>` with the organizer’s name:

> Hi — I’m the trip AI supplied by <organizer>. I can read the shared plan, answer trip questions, prepare or carry out permitted changes, and send important trip alerts. The organizer controls my access and can pause or remove me. I save structured trip facts, decisions, and action records—not unrelated group chat. Unmatched participants can ask questions but cannot change or vote on the plan.

## Delivery and activation

Wait for the provider to return the actual visible outbound message ID before calling `activate_trip_agent`. Pass that ID as `deliveryReceiptId`, with `privacyNoticeVersion: "v1"`. Never use an invented receipt, a draft ID, or an inbound message ID. Check readiness and complete organizer-controlled setup before activation.

This notice describes permitted capabilities. It does not mean proactive alerts are running: alerts require an approved trigger and a working provider workflow. The organizer can pause or remove access.

## Data boundary

The notice states the trip agent’s behavior contract: save structured trip facts, decisions, and action records, and ignore unrelated group conversation. It is not a promise about the messaging provider’s or model provider’s own chat retention; the organizer must check those services’ settings. Keep private reservation identity, booking references, documents, and credentials out of group replies.

The canonical text is exported by `privacyNotice(organizerName)` in `lib/trip-agent-wording.ts`. Tests protect the exact v1 notice.
