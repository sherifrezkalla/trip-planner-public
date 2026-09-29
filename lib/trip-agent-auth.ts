import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TripAgentScope } from "./trip-agent-contracts";

export type TripAgentConnectionStatus = "paired" | "active";

export type TripAgentAuthFailure = { status: 401 | 403 | 503; error: string };

export type TripAgentAuthSuccess = {
  connection: {
    id: string;
    tripId: string;
    lifecycleGeneration: number;
    status: TripAgentConnectionStatus;
    grantedScopes: TripAgentScope[];
    whatsappGroupDigest: string | null;
  };
  trip: Record<string, unknown>;
};

const INVALID_CREDENTIAL: TripAgentAuthFailure = {
  status: 401,
  error: "Invalid trip-agent credential",
};

const UNAVAILABLE: TripAgentAuthFailure = {
  status: 503,
  error: "Service temporarily unavailable — please try again in a moment",
};

const PAUSED: TripAgentAuthFailure = {
  status: 403,
  error: "Trip-agent connection is paused",
};

export const TRIP_AGENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A connector credential is an opaque 256-bit random value, returned once. */
export function generateTripAgentSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** The database stores only this digest, never the connector credential itself. */
export function digestTripAgentSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * A provider-specific person/group identifier must never cross the persistence
 * boundary in raw form. Including the connection and lifecycle generation
 * prevents correlation across trips and identity reuse after replacement.
 */
export function digestExternalIdentity(
  connectionId: string,
  lifecycleGeneration: number,
  rawIdentifier: string,
): string {
  const pepper = process.env.TRIP_AGENT_IDENTITY_PEPPER?.trim();
  if (!pepper) throw new Error("TRIP_AGENT_IDENTITY_PEPPER must be configured");
  return createHmac("sha256", pepper)
    .update(connectionId)
    .update("\0")
    .update(String(lifecycleGeneration))
    .update("\0")
    .update(rawIdentifier)
    .digest("hex");
}

/**
 * Only the exact HTTP authorization scheme is accepted. In particular, token
 * parsing must not normalize whitespace or casing and turn malformed input into
 * an authenticated request.
 */
export function bearerCredentialFrom(request: Request): string {
  const authorization = request.headers.get("authorization");
  // JavaScript's `$` also matches before a final line break. Length closes that
  // edge even for a non-normalizing HTTP adapter.
  if (authorization?.length !== 50) return "";
  return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "")?.[1] ?? "";
}

/**
 * Resolve a bearer credential before tool parsing. Paired connections are
 * deliberately admitted here: later adapters constrain them to setup tools.
 * Paused credentials return a distinct forbidden response so connectors can
 * stop retrying; revoked, archived, and unknown credentials remain indistinct.
 */
export async function authTripAgent(
  db: SupabaseClient,
  request: Request,
): Promise<TripAgentAuthSuccess | TripAgentAuthFailure> {
  const credential = bearerCredentialFrom(request);
  if (!credential) return INVALID_CREDENTIAL;

  let row: {
    id: string;
    trip_id: string;
    lifecycle_generation: number;
    status: string;
    granted_scopes: TripAgentScope[];
    whatsapp_group_digest: string | null;
    trip: Record<string, unknown> | null;
  } | null;
  try {
    const response = await db
      .from("trip_agent_connections")
      .select("id, trip_id, lifecycle_generation, status, granted_scopes, whatsapp_group_digest, trip:trips(*)")
      .eq("credential_digest", digestTripAgentSecret(credential))
      .maybeSingle();
    if (response.error) return UNAVAILABLE;
    row = response.data as typeof row;
  } catch {
    return UNAVAILABLE;
  }

  if (row?.status === "paused") return PAUSED;
  if (!row || !row.trip || (row.status !== "paired" && row.status !== "active")) {
    return INVALID_CREDENTIAL;
  }

  // Last-seen data is useful operationally, but is never permitted to decide
  // whether a caller may proceed.
  try {
    void Promise.resolve(
      db
        .from("trip_agent_connections")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("lifecycle_generation", row.lifecycle_generation),
    // A PostgREST response can carry an error instead of rejecting. Handling
    // both paths keeps telemetry detached from the authorization decision.
    ).then(() => undefined, () => undefined);
  } catch {
    // Best effort only, including a synchronously unavailable database client.
  }

  return {
    connection: {
      id: row.id,
      tripId: row.trip_id,
      lifecycleGeneration: row.lifecycle_generation,
      status: row.status,
      grantedScopes: row.granted_scopes,
      whatsappGroupDigest: row.whatsapp_group_digest,
    },
    trip: row.trip,
  };
}
