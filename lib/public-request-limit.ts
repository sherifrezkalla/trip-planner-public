/**
 * Ceilings on the routes that answer anyone.
 *
 * Three routes run before a trip or a traveller exists, so none of them can
 * authenticate with `authTraveler`. Two of the three spend money doing it:
 * `/api/places/autocomplete` proxies a billed Google Places search, and
 * `POST /api/trips` fetches a destination photo from the same billed API. The
 * caller's address is the only identity available, and it is kept only as a
 * salted hash for its quota window; abandoned buckets are swept after a day.
 *
 * The Origin check the autocomplete route also applies is not a control on its
 * own, since any client can send any Origin. This is the part that bounds the
 * spend.
 */

import { createHash } from "node:crypto";
import { serviceClient } from "./db";

/** Generous for a person typing a city, restrictive for a script. */
export const PLACE_LOOKUP_LIMIT = 30;
export const PLACE_LOOKUP_WINDOW_SECONDS = 60;

/**
 * Creating a trip is a deliberate act, not something done in a loop.
 *
 * A window an order of magnitude longer than the search's, because the abuse
 * being bounded is different: a script creating trips forever, each one costing
 * a photo lookup and a permanent row, rather than a burst of keystrokes. Ten an
 * hour is far past what a person planning trips will reach, and far below what
 * makes unattended creation worth anyone's while.
 */
export const TRIP_CREATE_LIMIT = 10;
export const TRIP_CREATE_WINDOW_SECONDS = 3600;

/** Pairing codes are short-lived but public, so exchanges get their own ceiling. */
export const TRIP_AGENT_PAIR_LIMIT = 20;
export const TRIP_AGENT_PAIR_WINDOW_SECONDS = 3600;

/**
 * Who is asking, as far as we are willing to know.
 *
 * `x-forwarded-for` is a client-supplied list that the platform prepends the
 * real address to, so only the first entry is trustworthy. An absent header
 * collapses everyone to one bucket, which fails closed: unattributable traffic
 * shares a single quota rather than escaping the limit entirely.
 *
 * The bucket name is part of the hash, so a caller's destination searches and
 * their trip creations are counted separately and neither can be inferred from
 * the other's rows.
 */
export function clientHash(headers: Headers, bucket: string): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || headers.get("x-real-ip")?.trim() || "unattributed";
  return createHash("sha256").update(`${bucket}:${address}`).digest("hex");
}

/**
 * True when this caller may spend another request against `bucket`.
 *
 * A limiter that fails open is not a limiter: if the ledger cannot be reached,
 * the answer is to spend nothing. That costs no availability that is not
 * already lost — both callers need the same database to do their real work, so
 * when it is unreachable the request could not have succeeded either way.
 *
 * The client is built in here, inside the guard, because `serviceClient()`
 * throws outright when its environment is missing rather than returning an
 * error. Constructed by the caller, that throw escapes as a 500; constructed
 * here it is just another reason to refuse.
 *
 * `record_place_lookup` is the RPC behind every bucket. Its parameters were
 * always general — a hash, a limit, a window — and only its name is specific.
 * Renaming a function and table that a live deployment is calling buys nothing
 * that a comment does not, so the name is left lagging deliberately.
 */
export async function allowPublicRequest(
  headers: Headers,
  options: { bucket: string; limit: number; windowSeconds: number },
): Promise<boolean> {
  return allowPublicHash(clientHash(headers, options.bucket), options);
}

async function allowPublicHash(
  hash: string,
  options: { limit: number; windowSeconds: number },
): Promise<boolean> {
  try {
    const { data, error } = await serviceClient().rpc("record_place_lookup", {
      p_client_hash: hash,
      p_limit: options.limit,
      p_window_seconds: options.windowSeconds,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** The destination search on the trip creation form. */
export function allowPlaceLookup(headers: Headers): Promise<boolean> {
  return allowPublicRequest(headers, {
    bucket: "place-lookup",
    limit: PLACE_LOOKUP_LIMIT,
    windowSeconds: PLACE_LOOKUP_WINDOW_SECONDS,
  });
}

/** Creating a trip, which is unauthenticated by design and buys a photo lookup. */
export function allowTripCreate(headers: Headers): Promise<boolean> {
  return allowPublicRequest(headers, {
    bucket: "trip-create",
    limit: TRIP_CREATE_LIMIT,
    windowSeconds: TRIP_CREATE_WINDOW_SECONDS,
  });
}

/** Exchanging a short-lived connector pairing code. */
export function allowTripAgentPair(headers: Headers): Promise<boolean> {
  return allowPublicRequest(headers, {
    bucket: "trip-agent-pair",
    limit: TRIP_AGENT_PAIR_LIMIT,
    windowSeconds: TRIP_AGENT_PAIR_WINDOW_SECONDS,
  });
}

/** Distributed attempts at one code share a bucket without persisting the code. */
export function allowTripAgentPairDigest(pairingDigest: string): Promise<boolean> {
  const hash = createHash("sha256").update(`trip-agent-pair-digest:${pairingDigest}`).digest("hex");
  return allowPublicHash(hash, {
    limit: TRIP_AGENT_PAIR_LIMIT,
    windowSeconds: TRIP_AGENT_PAIR_WINDOW_SECONDS,
  });
}
