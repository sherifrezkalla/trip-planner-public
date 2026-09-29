# Traveller Tokens

## What the token is

A traveller's token is the whole of their identity on a trip. There are no
accounts and no passwords: joining mints a token, the device keeps it in
`localStorage` under `tp:{slug}`, and every subsequent request proves who you
are by presenting it. It does not expire, it is not scoped to a session, and the
re-attach link carries the same string so it can be moved to another device.

That makes it a bearer credential with an unlimited lifetime, which is the fact
everything below follows from.

## The problem

Every **write** already sent the token in a JSON body. The **reads** could not —
a GET has no body — so three of them put it in the query string:

| Where | Was |
|---|---|
| board refresh | `GET /api/trips/{slug}?token=…` |
| Telegram link status | `GET /api/trips/{slug}/telegram/link?token=…` |
| re-attach link | `/t/{slug}/resume?k=…` |

A request body is not written to an access log. A URL always is — by Vercel, by
any proxy or CDN in front of it, and by whatever monitoring or log shipping
consumes them afterwards. So each of those requests deposited a permanent
credential, in plain text, in several systems that are backed up, searchable, and
readable by a much wider set of people than the trip itself.

This is worse than the same mistake with a session cookie. A leaked session ends
on its own; a leaked traveller token is good until someone notices and there is
currently no way to revoke one.

## What changed

**API reads move to a header.** `x-trip-token`, read by `travelerTokenFrom` in
`lib/auth.ts`. Headers are not logged the way URLs are.

**The re-attach link moves to the URL fragment.** `/t/{slug}/resume#k=…` instead
of `?k=…`. The fragment is the one part of a URL a browser never transmits: the
server sees `GET /t/{slug}/resume` and nothing else. It is also excluded from
`Referer`, so the token does not follow the traveller onto the next site either.
The link still survives being pasted, messaged, and opened on another device,
which is the whole purpose of it.

The resume page reads it client-side — it already did — and `router.replace`
still clears the URL once the token is stored, so it does not linger in history.

## Why the query string is still accepted

`travelerTokenFrom` reads the header first and falls back to `?token=`.
`parseResumeToken` reads the fragment first and falls back to `?k=`. Both
fallbacks are deliberate:

- **A deploy does not reload open tabs.** A board left open runs the old client
  until someone refreshes it. Refusing its requests would sign travellers out
  mid-trip in order to fix a logging problem — trading a real outage for a
  smaller harm.
- **Links already sent cannot be recalled.** Re-attach links are in people's
  messages. Nothing here can change the ones already out there; it can only stop
  minting more.

So this closes the path for new traffic rather than closing it outright. Removing
the fallbacks is a second change, safe once open sessions have turned over and
old links are assumed dead — there is no telemetry distinguishing them, so that
call is a judgement about elapsed time, not a measurement.

## Rejected alternatives

**`Authorization: Bearer`.** The conventional choice, and it is not one: proxies,
CDNs and platform edges sometimes strip, rewrite, or act on `Authorization`, and
this is not OAuth. A custom header has no existing semantics to fight.

**A cookie.** Correct for a session and wrong for this. A device holds a
*separate* token per trip — `tp:{slug}` — so cookies would need path scoping per
trip, and would be attached to every request to the origin including ones that
have nothing to do with that trip. It would also make the token invisible to the
code that has to put it into a re-attach link.

**Making the reads POSTs.** Would have worked and would have been quicker. It
misuses the verb, makes two idempotent reads look like writes to every tool in
the chain, and gives up caching semantics for a change a header already solves.

**Rotating or expiring tokens.** The real fix for "a log line is a durable
credential", and out of scope here. It redesigns identity for the whole app:
what a re-attach link means, what happens to a device holding an old token, and
what revocation looks like. Recorded below rather than attempted.

## Known limitations

- **Logs already written still contain tokens.** Nothing here scrubs history.
  Anyone with access to existing access logs holds working credentials for every
  traveller who used the board before this shipped.
- **Old `?k=` links still leak when clicked**, because the server must receive
  the request to serve the page at all.
- **The fallbacks keep the leak path open** for any client that chooses to use
  it. They are compatibility, not defence.
- **Tokens still never expire and cannot be revoked.** This change reduces how
  often one is written down; it does nothing about what a leaked one is worth.
  That is the follow-up, and it is a larger piece of work.
- **The fragment is still in the traveller's own browser history** until
  `router.replace` runs, and in whatever messaging app carried the link.
