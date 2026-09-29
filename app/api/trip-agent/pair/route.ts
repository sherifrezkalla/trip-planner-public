import { z } from "zod";
import { serviceClient } from "@/lib/db";
import {
  digestTripAgentSecret,
  generateTripAgentSecret,
  TRIP_AGENT_SECRET_PATTERN,
} from "@/lib/trip-agent-auth";
import { tripAgentProviderSchema } from "@/lib/trip-agent-contracts";
import {
  allowTripAgentPair,
  allowTripAgentPairDigest,
  TRIP_AGENT_PAIR_WINDOW_SECONDS,
} from "@/lib/public-request-limit";

const pairingRequestSchema = z.object({
  pairingCode: z.string().length(43).regex(TRIP_AGENT_SECRET_PATTERN),
  provider: tripAgentProviderSchema,
}).strict();

const INVALID_PAIRING = "Pairing code is invalid, expired, or already used";

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

function siteUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!productionHost) return null;
  return `https://${productionHost.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

/** A one-time public exchange from an organizer-issued pairing code to a bearer credential. */
export async function POST(request: Request): Promise<Response> {
  const parsed = pairingRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid pairing request" }, { status: 400 });

  const site = siteUrl();
  if (!site) {
    return json(
      { error: "Service temporarily unavailable — please try again in a moment" },
      { status: 503 },
    );
  }

  const pairingDigest = digestTripAgentSecret(parsed.data.pairingCode);
  if (!await allowTripAgentPair(request.headers) || !await allowTripAgentPairDigest(pairingDigest)) {
    return json(
      { error: "Too many pairing attempts. Try again in a little while." },
      { status: 429, headers: { "Retry-After": String(TRIP_AGENT_PAIR_WINDOW_SECONDS) } },
    );
  }

  const credential = generateTripAgentSecret();
  let pairing;
  try {
    pairing = await serviceClient().rpc("consume_trip_agent_pairing", {
      p_pairing_digest: pairingDigest,
      p_provider: parsed.data.provider,
      p_credential_digest: digestTripAgentSecret(credential),
      p_now: new Date().toISOString(),
    });
  } catch {
    return json(
      { error: "Service temporarily unavailable — please try again in a moment" },
      { status: 503 },
    );
  }

  const paired = Array.isArray(pairing.data) ? pairing.data[0] : null;
  if (pairing.error || !paired) return json({ error: INVALID_PAIRING }, { status: 400 });

  return json({
    credential,
    connectionId: paired.connection_id,
    tripId: paired.trip_id,
    status: "paired",
    mcpUrl: `${site}/api/mcp`,
  });
}
