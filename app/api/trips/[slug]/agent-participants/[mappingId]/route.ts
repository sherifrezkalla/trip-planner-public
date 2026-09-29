import { z } from "zod";

import { authTraveler, TRIP_TOKEN_HEADER } from "@/lib/auth";
import { serviceClient } from "@/lib/db";
import { canManageTripAgent } from "@/lib/permissions";

const travelerIdSchema = z.string().trim().min(1);
const mappingActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), travelerId: travelerIdSchema }).strict(),
  z.object({ action: z.literal("remap"), travelerId: travelerIdSchema }).strict(),
  z.object({ action: z.literal("revoke") }).strict(),
]);

const MAPPING_COLUMNS = [
  "id",
  "connection_id",
  "trip_id",
  "lifecycle_generation",
  "display_name_hint",
  "traveler_id",
  "status",
  "confirmed_by",
  "confirmed_at",
  "revoked_at",
  "created_at",
  "updated_at",
].join(", ");

type RouteContext = {
  params: Promise<{ slug: string; mappingId: string }>;
};

type MappingRow = {
  id: string;
  connection_id: string;
  trip_id: string;
  lifecycle_generation: number;
  display_name_hint: string | null;
  traveler_id: string | null;
  status: "suggested" | "confirmed" | "revoked";
  confirmed_by: string | null;
  confirmed_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

function redactedMapping(row: MappingRow) {
  return {
    id: row.id,
    displayNameHint: row.display_name_hint,
    travelerId: row.traveler_id,
    status: row.status,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function failure() {
  return json({ error: "Could not update trip agent participant" }, { status: 500 });
}

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

export async function PATCH(request: Request, { params }: RouteContext): Promise<Response> {
  const { slug, mappingId } = await params;
  try {
    const db = serviceClient();
    const token = request.headers.get(TRIP_TOKEN_HEADER)?.trim() ?? "";
    const auth = await authTraveler(db, slug, token);
    if ("error" in auth) {
      return json({ error: auth.error }, { status: auth.status });
    }
    const permission = canManageTripAgent({
      actorIsOrganizer: auth.me.is_organizer,
      actorIsBot: auth.me.is_bot !== false,
    });
    if (!permission.allowed) {
      return json({ error: permission.reason }, { status: 403 });
    }
    const parsed = mappingActionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return json({ error: "Invalid participant mapping action" }, { status: 400 });
    }

    const connectionResult = await db
      .from("trip_agent_connections")
      .select("id, lifecycle_generation")
      .eq("trip_id", auth.trip.id)
      .maybeSingle();
    if (connectionResult.error) return failure();
    if (!connectionResult.data) {
      return json({ error: "Participant mapping not found" }, { status: 404 });
    }
    const connection = connectionResult.data as { id: string; lifecycle_generation: number };

    const mappingResult = await db
      .from("trip_agent_participant_mappings")
      .select(MAPPING_COLUMNS)
      .eq("id", mappingId)
      .eq("trip_id", auth.trip.id)
      .eq("connection_id", connection.id)
      .eq("lifecycle_generation", connection.lifecycle_generation)
      .maybeSingle();
    if (mappingResult.error) return failure();
    if (!mappingResult.data) {
      return json({ error: "Participant mapping not found" }, { status: 404 });
    }
    const mapping = mappingResult.data as unknown as MappingRow;
    const now = new Date().toISOString();

    if (parsed.data.action === "revoke") {
      if (mapping.status === "revoked") {
        return json({ error: "Participant mapping is already revoked" }, { status: 409 });
      }
    } else {
      if (parsed.data.action === "confirm" && mapping.status === "confirmed") {
        return json({ error: "Use remap to change a confirmed participant mapping" }, { status: 409 });
      }
      if (parsed.data.action === "remap" && mapping.status !== "confirmed") {
        return json({ error: "Only a confirmed participant mapping can be remapped" }, { status: 409 });
      }
      const travelerResult = await db
        .from("travelers")
        .select("id, trip_id, is_bot")
        .eq("id", parsed.data.travelerId)
        .eq("trip_id", auth.trip.id)
        .maybeSingle();
      if (travelerResult.error) return failure();
      if (!travelerResult.data) {
        return json({ error: "Traveler does not belong to this trip" }, { status: 400 });
      }
    }

    const transition = await db.rpc("transition_trip_agent_participant_mapping", {
      p_connection_id: mapping.connection_id,
      p_trip_id: auth.trip.id,
      p_lifecycle_generation: mapping.lifecycle_generation,
      p_mapping_id: mapping.id,
      p_actor_id: auth.me.id,
      p_action: parsed.data.action,
      p_traveler_id: parsed.data.action === "revoke" ? null : parsed.data.travelerId,
      p_expected_updated_at: mapping.updated_at,
      p_expected_status: mapping.status,
      p_expected_traveler_id: mapping.traveler_id,
      p_now: now,
    });
    if (transition.error) {
      if ((transition.error as { code?: string }).code === "23505") {
        return json({ error: "Traveler already has a confirmed participant mapping" }, { status: 409 });
      }
      return failure();
    }
    const updated = Array.isArray(transition.data) ? transition.data[0] : null;
    if (!updated) {
      return json({ error: "Participant mapping changed before this action" }, { status: 409 });
    }

    return json({ mapping: redactedMapping(updated as unknown as MappingRow) });
  } catch {
    return failure();
  }
}
