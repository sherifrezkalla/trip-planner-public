import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { authTraveler, travelerTokenFrom } from "@/lib/auth";
import { serviceClient } from "@/lib/db";
import { canManageSchedule } from "@/lib/permissions";
import {
  inspectReservationArtifact,
  MAX_RESERVATION_ARTIFACT_CONTROL_BYTES,
  RESERVATION_DOWNLOAD_URL_TTL_SECONDS,
  RESERVATION_PROOF_BUCKET,
  RESERVATION_UPLOAD_URL_TTL_SECONDS,
  reservationArtifactExtension,
  retryReservationProofCleanup,
  sanitizeReservationArtifactFileName,
  type ReservationArtifactMediaType,
} from "@/lib/reservation-artifacts";
import { broadcastTripUpdate } from "@/lib/realtime";
import {
  beginReservationProofUploadSchema,
  finalizeReservationProofUploadSchema,
  reservationProofActionSchema,
} from "@/lib/schema";

async function smallJson(req: Request): Promise<{ value: unknown } | { response: NextResponse }> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESERVATION_ARTIFACT_CONTROL_BYTES) {
    return { response: NextResponse.json({ error: "Upload files directly to the issued Storage URL" }, { status: 413 }) };
  }
  const text = await req.text().catch(() => "");
  if (new TextEncoder().encode(text).byteLength > MAX_RESERVATION_ARTIFACT_CONTROL_BYTES) {
    return { response: NextResponse.json({ error: "Upload files directly to the issued Storage URL" }, { status: 413 }) };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { response: NextResponse.json({ error: "Invalid request" }, { status: 400 }) };
  }
}

async function organizerContext(req: Request, slug: string) {
  const db = serviceClient();
  const auth = await authTraveler(db, slug, travelerTokenFrom(req));
  if ("error" in auth) return { response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  const gate = canManageSchedule({ actorIsOrganizer: auth.me.is_organizer });
  if (!gate.allowed) return { response: NextResponse.json({ error: gate.reason }, { status: 403 }) };
  return { db, auth };
}

async function abandonUpload(
  db: ReturnType<typeof serviceClient>,
  auth: { trip: { id: string }; me: { id: string } },
  uploadId: string,
  reason: string,
) {
  const { data } = await db.rpc("abandon_reservation_proof_upload", {
    p_trip_id: auth.trip.id,
    p_actor_id: auth.me.id,
    p_artifact_id: uploadId,
    p_reason: reason,
  });
  const jobId = (data as { cleanup_job_id?: string } | null)?.cleanup_job_id;
  return jobId
    ? retryReservationProofCleanup(db, {
      tripId: auth.trip.id,
      actorId: auth.me.id,
      force: true,
      jobIds: [jobId],
    })
    : null;
}

/** Issue a small organizer-authenticated control response for a direct Storage upload. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const json = await smallJson(req);
  if ("response" in json) return json.response;
  const parsed = beginReservationProofUploadSchema.safeParse(json.value);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid proof upload" }, { status: 400 });
  }

  const context = await organizerContext(req, parsed.data.slug);
  if ("response" in context) return context.response!;
  const { db, auth } = context;
  const mediaType = parsed.data.mediaType as ReservationArtifactMediaType;
  const storagePath = `${auth.trip.id}/${id}/${randomUUID()}.${reservationArtifactExtension(mediaType)}`;
  const originalFileName = sanitizeReservationArtifactFileName(parsed.data.fileName, mediaType);

  const { data: pending, error: pendingError } = await db.rpc("begin_reservation_proof_upload", {
    p_trip_id: auth.trip.id,
    p_actor_id: auth.me.id,
    p_item_id: id,
    p_storage_path: storagePath,
    p_original_file_name: originalFileName,
    p_declared_media_type: mediaType,
    p_declared_byte_size: parsed.data.byteSize,
  });
  const uploadId = (pending as { artifact_id?: string } | null)?.artifact_id;
  if (pendingError || !uploadId) {
    const status = /not found/i.test(pendingError?.message ?? "") ? 404 : 500;
    return NextResponse.json({ error: status === 404 ? "Activity not found" : "Could not prepare proof upload" }, { status });
  }

  const { data: signed, error: signedError } = await db.storage
    .from(RESERVATION_PROOF_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false });
  if (signedError || !signed) {
    await abandonUpload(db, auth, uploadId, "signed_upload_issue_failed");
    return NextResponse.json({ error: "Could not issue a secure upload" }, { status: 500 });
  }

  await retryReservationProofCleanup(db, {
    tripId: auth.trip.id,
    actorId: auth.me.id,
    limit: 2,
  });
  return NextResponse.json({
    upload: {
      id: uploadId,
      path: signed.path,
      token: signed.token,
      expiresAt: new Date(Date.now() + RESERVATION_UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    },
  }, { status: 201 });
}

/** Validate Storage-owned metadata and atomically activate the uploaded object. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const json = await smallJson(req);
  if ("response" in json) return json.response;
  const parsed = finalizeReservationProofUploadSchema.safeParse(json.value);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid proof finalization" }, { status: 400 });
  }

  const context = await organizerContext(req, parsed.data.slug);
  if ("response" in context) return context.response!;
  const { db, auth } = context;
  const { data: upload, error: uploadError } = await db
    .from("reservation_proof_artifacts")
    .select("id, storage_path, declared_media_type, status")
    .eq("id", parsed.data.uploadId)
    .eq("itinerary_item_id", id)
    .eq("trip_id", auth.trip.id)
    .maybeSingle();
  if (uploadError) return NextResponse.json({ error: "Could not inspect pending proof" }, { status: 500 });
  if (!upload) return NextResponse.json({ error: "Proof upload not found" }, { status: 404 });
  if (upload.status === "active") return NextResponse.json({ outcome: "already_finalized" });
  if (upload.status !== "pending_upload") {
    return NextResponse.json({ error: "That proof upload is no longer current" }, { status: 409 });
  }

  let inspected;
  try {
    inspected = await inspectReservationArtifact(
      db.storage.from(RESERVATION_PROOF_BUCKET),
      upload.storage_path,
      upload.declared_media_type as ReservationArtifactMediaType,
    );
  } catch (error) {
    await abandonUpload(db, auth, upload.id, "content_validation_failed");
    const message = (error as Error).message;
    const status = /upload.*before|not found/i.test(message) ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }

  const { data: finalized, error: finalizeError } = await db.rpc("finalize_reservation_proof_upload", {
    p_trip_id: auth.trip.id,
    p_actor_id: auth.me.id,
    p_artifact_id: upload.id,
    p_media_type: inspected.mediaType,
    p_byte_size: inspected.byteSize,
    p_storage_etag: inspected.storageEtag,
    p_content_sha256: inspected.contentSha256,
  });
  if (finalizeError) return NextResponse.json({ error: "Could not attach proof" }, { status: 500 });
  const result = (finalized ?? {}) as { outcome?: string; cleanup_job_id?: string };
  const cleanup = result.cleanup_job_id
    ? await retryReservationProofCleanup(db, {
      tripId: auth.trip.id,
      actorId: auth.me.id,
      force: true,
      jobIds: [result.cleanup_job_id],
    })
    : null;
  if (result.outcome === "duplicate") {
    return NextResponse.json({ error: "That proof is already attached", cleanupPending: Boolean(cleanup?.failed) }, { status: 409 });
  }
  if (result.outcome === "stale") {
    return NextResponse.json({ error: "Another proof replacement finished first; reload and try again", cleanupPending: Boolean(cleanup?.failed) }, { status: 409 });
  }
  if (!result.outcome || !["created", "replaced", "already_finalized"].includes(result.outcome)) {
    return NextResponse.json({ error: "Could not attach proof" }, { status: 500 });
  }
  await broadcastTripUpdate(parsed.data.slug).catch(() => {});
  return NextResponse.json({ outcome: result.outcome, cleanupPending: Boolean(cleanup?.failed) }, {
    status: result.outcome === "created" ? 201 : 200,
  });
}

/** Issue a one-minute organizer-only signed download; the file bypasses Vercel. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  const context = await organizerContext(req, slug);
  if ("response" in context) return context.response!;
  const { db, auth } = context;
  const { data: artifact, error: artifactError } = await db
    .from("reservation_proof_artifacts")
    .select("storage_path, original_file_name")
    .eq("itinerary_item_id", id)
    .eq("trip_id", auth.trip.id)
    .eq("status", "active")
    .maybeSingle();
  if (artifactError) return NextResponse.json({ error: "Could not inspect proof" }, { status: 500 });
  if (!artifact) return NextResponse.json({ error: "Proof not found" }, { status: 404 });
  const { data: signed, error: signedError } = await db.storage
    .from(RESERVATION_PROOF_BUCKET)
    .createSignedUrl(artifact.storage_path, RESERVATION_DOWNLOAD_URL_TTL_SECONDS, {
      download: artifact.original_file_name,
    });
  if (signedError || !signed) return NextResponse.json({ error: "Could not issue a secure download" }, { status: 500 });
  return NextResponse.json({
    url: signed.signedUrl,
    fileName: artifact.original_file_name,
    expiresAt: new Date(Date.now() + RESERVATION_DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const json = await smallJson(req);
  if ("response" in json) return json.response;
  const parsed = reservationProofActionSchema.safeParse(json.value);
  if (!parsed.success) return NextResponse.json({ error: "A trip is required" }, { status: 400 });
  const context = await organizerContext(req, parsed.data.slug);
  if ("response" in context) return context.response!;
  const { db, auth } = context;
  const { data, error } = await db.rpc("remove_reservation_proof", {
    p_trip_id: auth.trip.id,
    p_actor_id: auth.me.id,
    p_item_id: id,
  });
  if (error) return NextResponse.json({ error: "Could not remove proof" }, { status: 500 });
  const result = (data ?? {}) as { outcome?: string; cleanup_job_id?: string };
  if (result.outcome === "not_found") return NextResponse.json({ error: "Proof not found" }, { status: 404 });
  const cleanup = result.cleanup_job_id
    ? await retryReservationProofCleanup(db, {
      tripId: auth.trip.id,
      actorId: auth.me.id,
      force: true,
      jobIds: [result.cleanup_job_id],
    })
    : { failed: 0 };
  await broadcastTripUpdate(parsed.data.slug).catch(() => {});
  return NextResponse.json({ cleanupPending: cleanup.failed > 0 }, { status: cleanup.failed > 0 ? 202 : 200 });
}

/** Explicit organizer retry for any durable cleanup jobs on this trip. */
export async function PUT(req: Request): Promise<NextResponse> {
  const json = await smallJson(req);
  if ("response" in json) return json.response;
  const parsed = reservationProofActionSchema.safeParse(json.value);
  if (!parsed.success) return NextResponse.json({ error: "A trip is required" }, { status: 400 });
  const context = await organizerContext(req, parsed.data.slug);
  if ("response" in context) return context.response!;
  const { db, auth } = context;
  const cleanup = await retryReservationProofCleanup(db, {
    tripId: auth.trip.id,
    actorId: auth.me.id,
    force: true,
    limit: 20,
  });
  return NextResponse.json(cleanup, { status: cleanup.failed > 0 ? 202 : 200 });
}
