# Failure Reporting

## The problem

Supabase returns errors in the result object rather than throwing. A read that
fails looks like this:

```ts
const { data, error } = await db.from("travelers").select("...");
```

Destructuring only `data` compiles, passes lint, passes every test, and reads
naturally. It is also how a database outage becomes a 200.

`GET /api/trips/[slug]` did exactly that on all four of its reads — travellers,
itinerary, suggestions, proposals. A failed read arrived as `null`, fell through
`?? []`, and rendered as an empty board:

| what happened | what the traveller saw |
|---|---|
| brand-new trip, nothing planned yet | an empty board |
| database unreachable | an empty board |

Those are the same response, on the surface that is the entire product. A
traveller opening their itinerary mid-trip and finding it blank has no way to
tell whether it is gone or whether the read failed, and the client cannot tell
either — it received a well-formed 200.

`POST /api/trips/[slug]/weather-scan` had the same shape with a sharper edge.
Both of its reads dropped their errors, so an unreachable database produced
`{ swaps: [], unclassified: 0 }` — which the organiser reads as *the forecast is
fine, nothing needs moving*, on the one day it would have mattered. Its exposure
write was unchecked too, so classifications could silently fail to cache while
the response still reported how many venues were left to do.

## The rule

**A read that failed is not a query that returned nothing.** Every route that
reads to build a response destructures `error` and refuses rather than serving a
partial answer as a complete one.

Emptiness is only ever reported when the database confirmed it.

## Shape of the refusal

The board reports all four reads together rather than the first that failed:

```json
{
  "error": "Could not load this trip (travellers, proposals).",
  "detail": "travellers: connection reset; proposals: connection reset"
}
```

For the same reason CI runs all three gates on a red run — one response naming
everything that is wrong beats three round trips discovering it one at a time.
`detail` carries the driver's own message, which is a deliberate choice: the
board already requires a valid traveller token, so the reader is someone
entitled to the trip's contents, and a message like `connection reset` tells an
organiser reporting a problem something a generic string does not.

## Rejected alternatives

**Serving partial results with a warning field.** A board missing its proposals
is not a board — voting silently disappears, and the "1 change waiting" heading
that would have shown it is exactly what a traveller would not notice missing.
Degraded modes are worth building where the missing piece is visibly optional;
none of these four are.

**Throwing and letting the framework render a 500.** It loses which read failed,
which is the only part worth having when someone reports a blank board.

**Retrying inside the request.** The client already re-fetches, and the board
polls. A retry here would multiply load against a database that is already
struggling to answer, which is the failure mode this is most likely to meet.

## Known limitations

- This covers the two routes audited. Other routes still swallow errors, and no
  lint rule enforces the convention — a `no-unused-vars`-style check for an
  undestructured `error` would, and does not exist yet.
- The board fails whole. One unavailable table takes the page down even when the
  other three answered, which is correct for these four and would not be for a
  genuinely optional read added later.
- A weather scan that fails midway has still spent its model calls on whatever
  it classified before the write failed. The classifications are lost with it,
  so the next scan pays again.
