import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectReservationArtifactMediaType,
  inspectReservationArtifact,
  retryReservationProofCleanup,
  serializeReservationArtifact,
} from "@/lib/reservation-artifacts";

const activeProof = {
  id: "proof-1",
  status: "active" as const,
  original_file_name: "private-confirmation-name.pdf",
  media_type: "application/pdf",
  byte_size: 512,
  created_at: "2026-08-26T10:00:00.000Z",
  uploader: { display_name: "Organizer" },
};

function cleanupQuery(job: { id: string; storage_path: string }) {
  const result = Promise.resolve({ data: [job], error: null });
  const builder: Record<string, unknown> = {
    then: result.then.bind(result),
  };
  for (const method of ["select", "eq", "order", "limit", "in", "lte"]) {
    builder[method] = () => builder;
  }
  return builder;
}

describe("reservation proof artifacts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the original filename organizer-only", () => {
    expect(serializeReservationArtifact(activeProof, false)).toEqual({
      id: "proof-1",
      mediaType: "application/pdf",
      byteSize: 512,
      uploadedAt: "2026-08-26T10:00:00.000Z",
      uploadedByName: "Organizer",
    });
    expect(serializeReservationArtifact(activeProof, true)).toMatchObject({
      fileName: "private-confirmation-name.pdf",
    });
  });

  it("recognizes only the supported file signatures", () => {
    expect(detectReservationArtifactMediaType(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(detectReservationArtifactMediaType(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
    expect(detectReservationArtifactMediaType(new TextEncoder().encode("plain text"))).toBeNull();
  });

  it("validates Storage-owned metadata and a bounded content prefix", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7");
    const storage = {
      info: vi.fn().mockResolvedValue({
        data: { size: bytes.byteLength, contentType: "application/pdf", etag: '"storage-etag-1"' },
        error: null,
      }),
      createSignedUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: "https://storage.test/inspect" },
        error: null,
      }),
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(inspectReservationArtifact(storage, "trip/item/proof.pdf", "application/pdf")).resolves.toEqual({
      mediaType: "application/pdf",
      byteSize: bytes.byteLength,
      storageEtag: "storage-etag-1",
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(fetchMock).toHaveBeenCalledWith("https://storage.test/inspect", { cache: "no-store" });
  });

  it("rejects content whose signature disagrees with the issued media type", async () => {
    const storage = {
      info: vi.fn().mockResolvedValue({
        data: { size: 8, contentType: "application/pdf", etag: "storage-etag-2" },
        error: null,
      }),
      createSignedUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: "https://storage.test/mismatch" },
        error: null,
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]), { status: 206 })));

    await expect(inspectReservationArtifact(
      storage,
      "trip/item/disguised.pdf",
      "application/pdf",
    )).rejects.toThrow("content does not match");
  });

  it("records failed deletion and can complete the same durable cleanup job on retry", async () => {
    const job = { id: "cleanup-1", storage_path: "trip/item/proof.pdf" };
    const remove = vi.fn()
      .mockResolvedValueOnce({ error: { message: "Storage temporarily unavailable" } })
      .mockResolvedValueOnce({ error: null });
    const rpc = vi.fn(async (name: string) => ({
      data: null,
      error: name === "complete_reservation_proof_cleanup" ? null : null,
    }));
    const db = {
      rpc,
      from: vi.fn(() => cleanupQuery(job)),
      storage: { from: vi.fn(() => ({ remove })) },
    };

    await expect(retryReservationProofCleanup(db as never, {
      tripId: "trip-1", actorId: "organizer-1", force: true,
    })).resolves.toEqual({ attempted: 1, succeeded: 0, failed: 1 });
    expect(rpc).toHaveBeenCalledWith("record_reservation_proof_cleanup_failure", {
      p_job_id: job.id,
      p_error: "Storage temporarily unavailable",
    });

    await expect(retryReservationProofCleanup(db as never, {
      tripId: "trip-1", actorId: "organizer-1", force: true,
    })).resolves.toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(rpc).toHaveBeenCalledWith("complete_reservation_proof_cleanup", { p_job_id: job.id });
  });

  it("locks replacement finalization and preserves durable cleanup metadata in the migration", () => {
    const migration = readFileSync(join(
      process.cwd(),
      "supabase/migrations/20260824212000_reservation_proof_artifacts.sql",
    ), "utf8").toLowerCase();
    expect(migration).toContain("perform 1 from trips where id = p_trip_id for update");
    expect(migration).toContain("expected_active_artifact_id");
    expect(migration).toContain("create table reservation_proof_cleanup_jobs");
    expect(migration).toContain("record_reservation_proof_cleanup_failure");
    expect(migration).toContain("v_current.content_sha256 = p_content_sha256");
  });
});
