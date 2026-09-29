import "server-only";

import { serviceClient } from "@/lib/db";
import { authTripAgent } from "@/lib/trip-agent-auth";
import { createTripAgentMcpHandler } from "@/lib/trip-agent-tools";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreHeaders = { "cache-control": "no-store" };

function boundaryFailure(): Response {
  return Response.json({ error: "Forbidden" }, {
    status: 403,
    headers: noStoreHeaders,
  });
}

function unavailableResponse(): Response {
  return Response.json({
    error: "Service temporarily unavailable — please try again in a moment",
  }, {
    status: 503,
    headers: noStoreHeaders,
  });
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizedAllowedHosts(): Set<string> | null {
  const configured = process.env.TRIP_AGENT_ALLOWED_HOSTS;
  if (!configured?.trim()) return null;

  const hosts = configured.split(",").map((host) => host.trim());
  if (hosts.length === 0 || hosts.some((host) => !isHostname(host))) return null;
  return new Set(hosts.map((host) => host.toLowerCase()));
}

function isHostname(value: string): boolean {
  if (!value || value.length > 253 || value.endsWith(".")) return false;
  const labels = value.split(".");
  return labels.every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
}

function requestHasAllowedTransportOrigin(request: Request): boolean {
  const allowedHosts = normalizedAllowedHosts();
  if (!allowedHosts) return false;

  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }
  if (!allowedHosts.has(requestUrl.hostname.toLowerCase())) return false;

  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).origin === requestUrl.origin;
  } catch {
    return false;
  }
}

async function handle(request: Request): Promise<Response> {
  if (!requestHasAllowedTransportOrigin(request)) return boundaryFailure();

  let db;
  let authentication;
  try {
    db = serviceClient();
    authentication = await authTripAgent(db, request);
  } catch {
    return unavailableResponse();
  }
  if ("error" in authentication) {
    return Response.json({ error: authentication.error }, {
      status: authentication.status,
      headers: noStoreHeaders,
    });
  }

  const response = await createTripAgentMcpHandler({
    db,
    connection: authentication.connection,
  }).fetch(request);
  return withNoStore(response);
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
