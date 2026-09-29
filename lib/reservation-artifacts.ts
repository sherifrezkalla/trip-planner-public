import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_RESERVATION_ARTIFACT_BYTES,
  RESERVATION_PROOF_BUCKET,
  type ReservationArtifactMediaType,
} from "./reservation-artifact-constants";

export {
  MAX_RESERVATION_ARTIFACT_BYTES,
  MAX_RESERVATION_ARTIFACT_CONTROL_BYTES,
  RESERVATION_ARTIFACT_TYPES,
  RESERVATION_DOWNLOAD_URL_TTL_SECONDS,
  RESERVATION_PROOF_BUCKET,
  RESERVATION_UPLOAD_URL_TTL_SECONDS,
  type ReservationArtifactMediaType,
} from "./reservation-artifact-constants";

export type ReservationArtifactRow = {
  id: string;
  status: "pending_upload" | "active" | "pending_delete" | "deleted";
  original_file_name: string;
  media_type: string | null;
  byte_size: number | null;
  created_at: string;
  uploader: { display_name: string } | null;
};

export type ReservationArtifact = {
  id: string;
  mediaType: string;
  byteSize: number;
  uploadedAt: string;
  uploadedByName: string;
  fileName?: string;
};

export function serializeReservationArtifact(
  proof: ReservationArtifactRow | null,
  isOrganizer: boolean,
): ReservationArtifact | null {
  if (!proof || proof.status !== "active" || !proof.media_type || proof.byte_size === null) return null;
  return {
    id: proof.id,
    mediaType: proof.media_type,
    byteSize: proof.byte_size,
    uploadedAt: proof.created_at,
    uploadedByName: proof.uploader?.display_name ?? "Organizer",
    ...(isOrganizer ? { fileName: proof.original_file_name } : {}),
  };
}

export function reservationArtifactExtension(mediaType: ReservationArtifactMediaType): string {
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType === "image/jpeg") return "jpg";
  return mediaType.slice("image/".length);
}

export function sanitizeReservationArtifactFileName(
  value: string,
  mediaType: ReservationArtifactMediaType,
): string {
  const leaf = value.split(/[\\/]/).at(-1) ?? "";
  const safe = leaf.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  return safe || `reservation-proof.${reservationArtifactExtension(mediaType)}`;
}

export function detectReservationArtifactMediaType(prefix: Uint8Array): ReservationArtifactMediaType | null {
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) {
    return "image/jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (prefix.length >= png.length && png.every((byte, index) => prefix[index] === byte)) {
    return "image/png";
  }
  const ascii = (start: number, text: string) =>
    [...text].every((character, index) => prefix[start + index] === character.charCodeAt(0));
  if (prefix.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    return "image/webp";
  }
  const pdf = [..."%PDF-"].map((character) => character.charCodeAt(0));
  const searchLimit = Math.min(prefix.length - pdf.length + 1, 1024);
  for (let offset = 0; offset < searchLimit; offset += 1) {
    if (pdf.every((byte, index) => prefix[offset + index] === byte)) return "application/pdf";
  }
  return null;
}

type StorageInfo = {
  size?: number;
  contentType?: string;
  etag?: string;
  metadata?: { size?: number; contentLength?: number; mimetype?: string; eTag?: string };
};

type StorageBucket = {
  info(path: string): Promise<{ data: StorageInfo | null; error: { message: string } | null }>;
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
};

async function inspectStorageObject(
  url: string,
  expectedByteSize: number,
  prefixByteCount = 1024,
): Promise<{ prefix: Uint8Array; contentSha256: string }> {
  const response = await fetch(url, {
    cache: "no-store",
  });
  if (!response.ok || !response.body) throw new Error("Could not inspect uploaded proof");

  const reader = response.body.getReader();
  const prefix = new Uint8Array(Math.min(prefixByteCount, expectedByteSize));
  const hash = createHash("sha256");
  let totalBytes = 0;
  let prefixBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > expectedByteSize || totalBytes > MAX_RESERVATION_ARTIFACT_BYTES) {
        throw new Error("Uploaded proof size changed during validation");
      }
      hash.update(value);
      const prefixRemaining = prefix.length - prefixBytes;
      if (prefixRemaining > 0) {
        const copied = Math.min(value.byteLength, prefixRemaining);
        prefix.set(value.subarray(0, copied), prefixBytes);
        prefixBytes += copied;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (totalBytes !== expectedByteSize) {
    throw new Error("Uploaded proof size changed during validation");
  }
  return {
    prefix: prefix.subarray(0, prefixBytes),
    contentSha256: hash.digest("hex"),
  };
}

function normalizeStorageEtag(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9+/_=-]+$/.test(normalized)) return null;
  return normalized;
}

export type InspectedReservationArtifact = {
  mediaType: ReservationArtifactMediaType;
  byteSize: number;
  storageEtag: string;
  contentSha256: string;
};

/**
 * Inspect Storage-owned metadata and stream the private object once for a
 * bounded signature check plus a server-computed content hash. Organizer
 * transfer bytes never cross the Function's public request/response boundary.
 */
export async function inspectReservationArtifact(
  storage: StorageBucket,
  path: string,
  expectedMediaType: ReservationArtifactMediaType,
): Promise<InspectedReservationArtifact> {
  const { data: info, error: infoError } = await storage.info(path);
  if (infoError || !info) throw new Error("Upload the proof before finalizing it");

  const byteSize = info.size ?? info.metadata?.size ?? info.metadata?.contentLength;
  const mediaType = info.contentType ?? info.metadata?.mimetype;
  const storageEtag = normalizeStorageEtag(info.etag ?? info.metadata?.eTag);
  if (!Number.isInteger(byteSize) || !byteSize || byteSize > MAX_RESERVATION_ARTIFACT_BYTES) {
    throw new Error("Proof files must be between 1 byte and 8 MB");
  }
  if (mediaType !== expectedMediaType || !storageEtag) {
    throw new Error("Uploaded proof metadata did not match the issued transfer");
  }

  const { data: signed, error: signedError } = await storage.createSignedUrl(path, 30);
  if (signedError || !signed) throw new Error("Could not inspect uploaded proof");
  const inspected = await inspectStorageObject(signed.signedUrl, byteSize);
  const detected = detectReservationArtifactMediaType(inspected.prefix);
  if (detected !== expectedMediaType) {
    throw new Error("The uploaded file content does not match its media type");
  }
  return { mediaType: detected, byteSize, storageEtag, contentSha256: inspected.contentSha256 };
}

type CleanupJob = {
  id: string;
  storage_path: string;
};

export type CleanupResult = {
  attempted: number;
  succeeded: number;
  failed: number;
};

/**
 * Retry durable cleanup jobs. Database RPCs keep attempt history and artifact
 * state changes atomic even if a Storage deletion or Function invocation fails.
 */
export async function retryReservationProofCleanup(
  db: SupabaseClient,
  args: {
    tripId: string;
    actorId: string;
    force?: boolean;
    jobIds?: string[];
    limit?: number;
  },
): Promise<CleanupResult> {
  const result: CleanupResult = { attempted: 0, succeeded: 0, failed: 0 };
  const { error: expiryError } = await db.rpc("enqueue_expired_reservation_proof_uploads", {
    p_trip_id: args.tripId,
    p_actor_id: args.actorId,
  });
  if (expiryError) return { ...result, failed: 1 };

  let query = db
    .from("reservation_proof_cleanup_jobs")
    .select("id, storage_path")
    .eq("trip_id", args.tripId)
    .eq("status", "pending")
    .order("created_at")
    .limit(args.limit ?? 5);
  if (args.jobIds?.length) query = query.in("id", args.jobIds);
  else if (!args.force) query = query.lte("next_retry_at", new Date().toISOString());

  const { data: jobs, error: jobsError } = await query;
  if (jobsError) return { ...result, failed: 1 };

  for (const job of (jobs ?? []) as CleanupJob[]) {
    result.attempted += 1;
    const { error: removeError } = await db.storage
      .from(RESERVATION_PROOF_BUCKET)
      .remove([job.storage_path]);
    if (removeError) {
      result.failed += 1;
      await db.rpc("record_reservation_proof_cleanup_failure", {
        p_job_id: job.id,
        p_error: removeError.message.slice(0, 500),
      });
      continue;
    }
    const { error: completeError } = await db.rpc("complete_reservation_proof_cleanup", {
      p_job_id: job.id,
    });
    if (completeError) result.failed += 1;
    else result.succeeded += 1;
  }
  return result;
}
