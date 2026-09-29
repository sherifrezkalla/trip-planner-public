import { serviceClient } from "@/lib/db";
import { authTraveler, TRIP_TOKEN_HEADER } from "@/lib/auth";
import { canManageTripAgent } from "@/lib/permissions";
import { z } from "zod";
import {
  createTripAgentConnectionSchema,
  updateTripAgentConnectionSchema,
} from "@/lib/schema";
import {
  digestTripAgentSecret,
  generateTripAgentSecret,
} from "@/lib/trip-agent-auth";

const PAIRING_TTL_MS = 10 * 60 * 1_000;
const CONNECTION_COLUMNS = [
  "id",
  "trip_id",
  "provider",
  "status",
  "lifecycle_generation",
  "pairing_expires_at",
  "granted_scopes",
  "authority_policy",
  "agent_phone_e164",
  "whatsapp_group_label",
  "whatsapp_group_digest",
  "privacy_notice_version",
  "privacy_notice_message_digest",
  "last_seen_at",
  "paired_at",
  "activated_at",
  "paused_at",
  "revoked_at",
  "archived_at",
  "created_at",
  "updated_at",
].join(", ");
const FAILURE = "Could not manage trip agent connection";

type RouteContext = { params: Promise<{ slug: string }> };
type ConnectionRow = {
  id: string;
  trip_id: string;
  provider: string;
  status: string;
  lifecycle_generation: number;
  pairing_expires_at?: string | null;
  granted_scopes: string[];
  authority_policy: {
    travelerCanAddSuggestion: boolean;
    travelerCanProposeChange: boolean;
  };
  agent_phone_e164: string | null;
  whatsapp_group_label: string | null;
  whatsapp_group_digest?: string | null;
  privacy_notice_version?: string | null;
  privacy_notice_message_digest?: string | null;
  last_seen_at?: string | null;
  paired_at: string | null;
  activated_at: string | null;
  paused_at: string | null;
  revoked_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

function redactedConnection(row: ConnectionRow) {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    lifecycleGeneration: row.lifecycle_generation,
    pairingExpiresAt: row.pairing_expires_at ?? null,
    grantedScopes: row.granted_scopes,
    authorityPolicy: row.authority_policy,
    agentPhoneE164: row.agent_phone_e164,
    whatsappGroupLabel: row.whatsapp_group_label,
    groupRegistered: Boolean(row.whatsapp_group_digest && row.whatsapp_group_label?.trim()),
    privacyNoticeDelivered: row.privacy_notice_version === "v1" && Boolean(row.privacy_notice_message_digest),
    lastSeenAt: row.last_seen_at ?? null,
    pairedAt: row.paired_at,
    activatedAt: row.activated_at,
    pausedAt: row.paused_at,
    revokedAt: row.revoked_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function authorize(request: Request, slug: string) {
  const db = serviceClient();
  const token = request.headers.get(TRIP_TOKEN_HEADER)?.trim() ?? "";
  const auth = await authTraveler(db, slug, token);
  if ("error" in auth) {
    return { response: json({ error: auth.error }, { status: auth.status }) } as const;
  }
  const permission = canManageTripAgent({
    actorIsOrganizer: auth.me.is_organizer,
    actorIsBot: auth.me.is_bot !== false,
  });
  if (!permission.allowed) {
    return { response: json({ error: permission.reason }, { status: 403 }) } as const;
  }
  return { db, auth } as const;
}

async function readConnection(
  db: ReturnType<typeof serviceClient>,
  tripId: string,
): Promise<{ data: ConnectionRow | null; error: unknown }> {
  const result = await db
    .from("trip_agent_connections")
    .select(CONNECTION_COLUMNS)
    .eq("trip_id", tripId)
    .maybeSingle();
  return { data: result.data as ConnectionRow | null, error: result.error };
}

function databaseFailure() {
  return json({ error: FAILURE }, { status: 500 });
}

function lifecycleConflict(message: string) {
  return json({ error: message }, { status: 409 });
}

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

type MappingSummaryRow = {
  id: string;
  display_name_hint: string | null;
  traveler_id: string | null;
  status: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

type ActionSummaryRow = {
  id: string;
  mapped_traveler_id: string | null;
  operation: string;
  authority_decision: string;
  status: string;
  error_code: string | null;
  announcement_status: string;
  proposal_id: string | null;
  canonical_reference: unknown;
  created_at: string;
  updated_at: string;
  executed_at: string | null;
};

function redactedMapping(row: MappingSummaryRow) {
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

const canonicalReferenceKinds = new Set(["plan_proposal", "reservation_attempt"]);

function safeUuid(value: unknown): string | null {
  const parsed = z.string().uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}

function canonicalReference(value: unknown): { kind: string; id: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = safeUuid(record.id);
  if (typeof record.kind !== "string" || !canonicalReferenceKinds.has(record.kind) || !id) return null;
  return { kind: record.kind, id };
}

function redactedAction(row: ActionSummaryRow) {
  return {
    id: row.id,
    mappedTravelerId: row.mapped_traveler_id,
    operation: row.operation,
    authorityDecision: row.authority_decision,
    status: row.status,
    errorCode: row.error_code,
    announcementStatus: row.announcement_status,
    proposalId: safeUuid(row.proposal_id),
    canonicalReference: canonicalReference(row.canonical_reference),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    executedAt: row.executed_at,
  };
}

/** Preserve `updated_at` as a CAS token even when JavaScript's clock stalls. */
function nextConnectionVersion(observedUpdatedAt?: string): string {
  const observedMilliseconds = observedUpdatedAt ? Date.parse(observedUpdatedAt) : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(Date.now(), observedMilliseconds + 1)).toISOString();
}

export async function GET(request: Request, { params }: RouteContext): Promise<Response> {
  const { slug } = await params;
  try {
    const authorized = await authorize(request, slug);
    if ("response" in authorized && authorized.response) return authorized.response;

    const { data, error } = await readConnection(authorized.db, authorized.auth.trip.id);
    if (error) return databaseFailure();
    if (!data) return json({ connection: null, mappings: [], recentActions: [] });

    const [mappings, actions] = await Promise.all([
      authorized.db.from("trip_agent_participant_mappings")
        .select("id, display_name_hint, traveler_id, status, confirmed_by, confirmed_at, revoked_at, created_at, updated_at")
        .eq("connection_id", data.id)
        .eq("trip_id", data.trip_id)
        .eq("lifecycle_generation", data.lifecycle_generation),
      authorized.db.from("trip_agent_actions")
        .select("id, mapped_traveler_id, operation, authority_decision, status, error_code, announcement_status, proposal_id, canonical_reference, created_at, updated_at, executed_at")
        .eq("connection_id", data.id)
        .eq("trip_id", data.trip_id)
        .eq("lifecycle_generation", data.lifecycle_generation)
        .order("created_at", { ascending: false })
        .limit(25),
    ]);
    if (mappings.error || actions.error) return databaseFailure();
    const current = await readConnection(authorized.db, authorized.auth.trip.id);
    if (current.error) return databaseFailure();
    if (!current.data
      || current.data.id !== data.id
      || current.data.lifecycle_generation !== data.lifecycle_generation
      || current.data.updated_at !== data.updated_at) {
      return lifecycleConflict("The trip agent connection changed while its status was loading");
    }
    return json({
      connection: redactedConnection(data),
      mappings: ((mappings.data ?? []) as MappingSummaryRow[]).map(redactedMapping),
      recentActions: ((actions.data ?? []) as ActionSummaryRow[]).map(redactedAction),
    });
  } catch {
    return databaseFailure();
  }
}

export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  const { slug } = await params;
  try {
    const authorized = await authorize(request, slug);
    if ("response" in authorized && authorized.response) return authorized.response;

    const parsed = createTripAgentConnectionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "Invalid trip agent connection" }, { status: 400 });

    const existing = await readConnection(authorized.db, authorized.auth.trip.id);
    if (existing.error) return databaseFailure();
    if (existing.data && !["pending", "revoked", "archived"].includes(existing.data.status)) {
      return lifecycleConflict("An existing trip agent connection must be revoked before replacement");
    }

    const pairingCode = generateTripAgentSecret();
    const pairingExpiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    const setup = {
      provider: parsed.data.provider,
      status: "pending",
      credential_digest: null,
      pairing_code_digest: digestTripAgentSecret(pairingCode),
      pairing_expires_at: pairingExpiresAt,
      granted_scopes: ["connector.setup"],
      authority_policy: {
        travelerCanAddSuggestion: true,
        travelerCanProposeChange: true,
      },
      paired_at: null,
      activated_at: null,
      paused_at: null,
      revoked_at: null,
      archived_at: null,
      agent_phone_e164: null,
      whatsapp_group_digest: null,
      whatsapp_group_label: null,
      privacy_notice_version: null,
      privacy_notice_message_digest: null,
      last_seen_at: null,
      updated_at: nextConnectionVersion(existing.data?.updated_at),
    };

    let data: unknown;
    let error: unknown;
    if (existing.data && ["revoked", "archived"].includes(existing.data.status)) {
      const replacement = await authorized.db.rpc("replace_trip_agent_connection", {
        p_connection_id: existing.data.id,
        p_expected_updated_at: existing.data.updated_at,
        p_provider: parsed.data.provider,
        p_pairing_digest: setup.pairing_code_digest,
        p_pairing_expires_at: pairingExpiresAt,
        p_actor_id: authorized.auth.me.id,
        p_now: setup.updated_at,
      });
      data = Array.isArray(replacement.data) ? replacement.data[0] : null;
      error = replacement.error;
    } else {
      const write = existing.data
        ? authorized.db
            .from("trip_agent_connections")
            .update(setup)
            .eq("id", existing.data.id)
            .eq("lifecycle_generation", existing.data.lifecycle_generation)
            .eq("updated_at", existing.data.updated_at)
        : authorized.db.from("trip_agent_connections").insert({
            trip_id: authorized.auth.trip.id,
            ...setup,
          });
      const result = await write.select(CONNECTION_COLUMNS).maybeSingle();
      data = result.data;
      error = result.error;
    }
    if (error) return databaseFailure();
    if (!data) {
      return existing.data
        ? lifecycleConflict("The trip agent connection changed before this pairing code could be issued")
        : databaseFailure();
    }

    return json({
      connection: redactedConnection(data as unknown as ConnectionRow),
      pairingCode,
      pairingExpiresAt,
    }, { status: 201 });
  } catch {
    return databaseFailure();
  }
}

export async function PATCH(request: Request, { params }: RouteContext): Promise<Response> {
  const { slug } = await params;
  try {
    const authorized = await authorize(request, slug);
    if ("response" in authorized && authorized.response) return authorized.response;

    const parsed = updateTripAgentConnectionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "Invalid trip agent connection action" }, { status: 400 });

    const existing = await readConnection(authorized.db, authorized.auth.trip.id);
    if (existing.error) return databaseFailure();
    if (!existing.data) return json({ error: "Trip agent connection not found" }, { status: 404 });
    const current = existing.data;
    const terminal = current.status === "revoked" || current.status === "archived";
    let update: Record<string, unknown>;

    switch (parsed.data.action) {
      case "pause":
        if (terminal || !["paired", "active", "paused"].includes(current.status)) {
          return lifecycleConflict("This trip agent connection cannot be paused");
        }
        update = { status: "paused", paused_at: new Date().toISOString() };
        break;
      case "resume":
        if (terminal) return lifecycleConflict("Revoked or archived trip agent connections cannot be resumed");
        if (current.status !== "paused") {
          return lifecycleConflict("Only a paused trip agent connection can be resumed");
        }
        update = {
          status: current.activated_at ? "active" : "paired",
          paused_at: null,
        };
        break;
      case "rotate": {
        if (terminal || !["paired", "active", "paused"].includes(current.status)) {
          return lifecycleConflict("This trip agent credential cannot be rotated");
        }
        const credential = generateTripAgentSecret();
        const rotation = await authorized.db.rpc("rotate_trip_agent_credential", {
          p_connection_id: current.id,
          p_expected_updated_at: current.updated_at,
          p_credential_digest: digestTripAgentSecret(credential),
          p_actor_id: authorized.auth.me.id,
          p_now: nextConnectionVersion(current.updated_at),
        });
        const rotated = Array.isArray(rotation.data) ? rotation.data[0] : null;
        if (rotation.error) return databaseFailure();
        if (!rotated) return lifecycleConflict("The trip agent connection changed before its credential could be rotated");
        return json({
          // The rotation RPC returns a safe partial row. Its CAS validates the
          // snapshot, and rotation preserves group/notice evidence.
          connection: redactedConnection({ ...current, ...rotated } as ConnectionRow),
          credential,
        });
      }
      case "archive":
        if (terminal) return lifecycleConflict("Revoked or archived trip agent connections are terminal");
        update = {
          status: "archived",
          credential_digest: null,
          pairing_code_digest: null,
          pairing_expires_at: null,
          archived_at: new Date().toISOString(),
        };
        break;
      case "update_policy":
        if (terminal) return lifecycleConflict("Revoked or archived trip agent connections are terminal");
        update = {
          authority_policy: {
            travelerCanAddSuggestion: parsed.data.travelerCanAddSuggestion,
            travelerCanProposeChange: parsed.data.travelerCanProposeChange,
          },
          granted_scopes: parsed.data.grantedScopes,
        };
        break;
      case "update_metadata":
        if (terminal) return lifecycleConflict("Revoked or archived trip agent connections are terminal");
        update = {
          agent_phone_e164: parsed.data.agentPhoneE164,
          whatsapp_group_label: parsed.data.whatsappGroupLabel,
        };
        break;
    }

    const { data, error } = await authorized.db
      .from("trip_agent_connections")
      .update({ ...update, updated_at: nextConnectionVersion(current.updated_at) })
      .eq("id", current.id)
      .eq("lifecycle_generation", current.lifecycle_generation)
      .eq("updated_at", current.updated_at)
      .select(CONNECTION_COLUMNS)
      .maybeSingle();
    if (error) return databaseFailure();
    if (!data) return lifecycleConflict("The trip agent connection changed before this action could be applied");

    return json({
      connection: redactedConnection(data as unknown as ConnectionRow),
    });
  } catch {
    return databaseFailure();
  }
}

export async function DELETE(request: Request, { params }: RouteContext): Promise<Response> {
  const { slug } = await params;
  try {
    const authorized = await authorize(request, slug);
    if ("response" in authorized && authorized.response) return authorized.response;

    const existing = await readConnection(authorized.db, authorized.auth.trip.id);
    if (existing.error) return databaseFailure();
    if (!existing.data) return json({ error: "Trip agent connection not found" }, { status: 404 });
    if (existing.data.status === "revoked" || existing.data.status === "archived") {
      return lifecycleConflict("Revoked or archived trip agent connections are terminal");
    }

    const { data, error } = await authorized.db
      .from("trip_agent_connections")
      .update({
        status: "revoked",
        credential_digest: null,
        pairing_code_digest: null,
        pairing_expires_at: null,
        revoked_at: new Date().toISOString(),
        updated_at: nextConnectionVersion(existing.data.updated_at),
      })
      .eq("id", existing.data.id)
      .eq("lifecycle_generation", existing.data.lifecycle_generation)
      .eq("updated_at", existing.data.updated_at)
      .select(CONNECTION_COLUMNS)
      .maybeSingle();
    if (error) return databaseFailure();
    if (!data) return lifecycleConflict("The trip agent connection changed before it could be revoked");
    return json({ connection: redactedConnection(data as unknown as ConnectionRow) });
  } catch {
    return databaseFailure();
  }
}
