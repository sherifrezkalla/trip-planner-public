# Public Endpoint Limits

## The problem

Three routes answer anyone who asks, because each runs before a trip exists:

| Route | Upstream | Cost of abuse | Ceiling |
|---|---|---|---|
| `/api/places/autocomplete` | Google Places Text Search | **Billed per request** | 30 / minute |
| `POST /api/trips` | Google Places photo lookup | **Billed per request**, and writes a permanent row | 10 / hour |
| `/api/weather` | Open-Meteo | Free and keyless | none, deliberately |

Every other route authenticates with `authTraveler`. These three cannot: the
destination search runs on the trip creation form, where there is no trip and
no traveller yet; creating a trip is what mints the first traveller's link, so
there is nothing to authenticate against; and the weather panel is keyed on
coordinates alone.

This document said "two routes" for its first version, and the omission was not
harmless — it was the reason `POST /api/trips` shipped uncapped. The route was
read as internal because the note describing the public surface did not list it,
while it was in fact the more expensive of the two billed ones: a destination
search spends a Places call, and creating a trip spends a Places call *and*
leaves a row behind that nothing reclaims.

## Why the origin check was not enough

The destination search already compared the request's `Origin`, falling back to
`Referer`, against its own host. But the comparison ran inside `if (header)`, so
a request carrying neither header skipped it entirely:

```
Origin: https://evil.example.com  ->  403
no Origin, no Referer             ->  200
```

Browsers always send one of the two, so the guard turned away other *sites*
while waving through everything that was not a browser — curl, a script, a
scraper — which is the traffic that actually runs up a bill. A missing header
now fails the check.

**This is a fence, not a control.** Any client can send any `Origin`, so a
deliberate attacker forges one and walks through. It is worth keeping because it
costs nothing and stops casual embedding, but it must not be mistaken for the
protection.

## What actually bounds the spend

A per-caller ceiling: 30 lookups per 60 seconds, counted in `place_lookups` and
enforced by `record_place_lookup`. Counting, deciding, and recording happen in
one function so two requests arriving together cannot both read the same count
and both be admitted.

Three details that are decisions rather than mechanics:

- **The limiter fails closed.** If the ledger cannot be reached, the request is
  refused. A limiter that fails open under load is not a limiter, and load is
  exactly when it is being tested. This costs no availability that is not
  already lost: submitting the form needs the same database, so when it is
  unreachable a trip cannot be created either way.
- **The database client is built inside the guard.** `serviceClient()` throws
  outright when its environment is missing rather than returning an error.
  Constructed by the caller, that throw escapes as a 500 on the one endpoint a
  trip cannot be created without; constructed inside the guard it is just
  another reason to refuse. This is not hypothetical — preview deployments have
  no Supabase credentials and reproduce it exactly.
- **Queries under two characters never reach it.** They cannot reach Google
  either, so charging them against a quota would punish typing.
- **Unattributable callers share one bucket.** With no `x-forwarded-for`, the
  hash is a constant, so traffic that hides its address contends for a single
  quota instead of escaping the limit.

Only the first entry of `x-forwarded-for` is used. The rest is client-supplied
and can say anything.

## Identity, and how little of it is kept

The caller's address is the only identity available, and it is stored as a
salted SHA-256 hash, never in the clear. Rows are swept by age across all
callers on every request, so the table stays bounded to one window and a
one-shot address cannot leave a row behind.

This is short-lived obfuscation, not anonymisation — IPv4 is small enough to
brute-force a hash. The protection is the retention window, not the hash.

## The client half

The form debounces to one lookup per 300ms pause and abandons the in-flight
request when the query moves on. This is a cost fix before it is a UX fix:
`search()` previously fired on every keystroke, so typing "Barcelona" spent
eight billed Google calls in normal, legitimate use. Most of the saving here is
against ordinary traffic, not abuse.

A 429 surfaces in the form's existing error line. That matters more than it
looks: a trip cannot be created without choosing a suggestion, so a silently
empty list is indistinguishable from a destination that does not exist.

## Creating a trip

The ceiling is 10 per hour, against the search's 30 per minute, because the
abuse is a different shape. A person typing a city name generates a burst of
keystrokes and needs headroom within seconds; a person creating a trip does it
deliberately, a handful of times at most. An hour-long window is far past what
real use reaches and far below what makes unattended creation worth running.

It is checked after payload validation, so a malformed body costs no slot, and
before the photo lookup, so a refused caller spends nothing.

Both ceilings share the `record_place_lookup` RPC and the `place_lookups` table.
Its parameters were always general — a hash, a limit, a window — and only its
name is specific. The bucket name is folded into the hash, so a caller's
searches and their trip creations count separately and neither can be inferred
from the other's rows. Renaming a function and table that a live deployment is
calling would buy nothing a comment does not, so the name is left lagging
deliberately; `lib/public-request-limit.ts` is where the generality lives.

Rejected: requiring a captcha or an account to create a trip. The private-link
model is the product — a trip is shareable precisely because joining needs
nothing but the link — and an identity check at creation would be the first
crack in that. A ceiling costs a determined abuser one address per ten trips and
costs a real organiser nothing.

## Weather is deliberately left open

`/api/weather` takes coordinates from anyone, with no token and no ceiling, and
each pair mints a cache entry. That is accepted: Open-Meteo is free and keyless,
the route returns no trip data, and the worst case is spent Vercel invocations
rather than money. If it ever proxies a billed provider, it needs this
treatment first.

## Preview deployments cannot exercise this

Preview deployments have no `SUPABASE_URL`, so every database-backed route
fails there — `/api/health` has been returning 500 on previews since at least
11 Aug 2026, well before this change. Production is configured correctly and
unaffected.

It is worth stating plainly because it shapes what a preview can be trusted to
prove: for anything touching the database, a green preview means the bundle
built, not that the feature works. This limiter was verified against the
database directly and in unit tests instead. Adding the Supabase variables to
the Preview environment would close the gap.

## Known limitations

- The origin check is forgeable and always will be. The ceiling is the control.
- The ceiling is per address, so a distributed caller gets a quota per address.
- Retention sweeps on request. An endpoint that goes completely idle keeps its
  last window of rows until someone calls it again.
- `place_lookups` writes on the request path, so each lookup carries a database
  round trip. Debouncing keeps that off the keystroke path.
- Identical queries are not cached, so two people searching "Example City" a second
  apart spend two Google calls.
- Ten trips an hour per address is generous for one household and restrictive
  for an office behind a single NAT. No one has hit it; if a group does, the
  limit is a constant in `lib/public-request-limit.ts`.
- The `place_lookups` table now serves buckets that are not place lookups. The
  name is wrong and knowingly so, for the reason given above.
