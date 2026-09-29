import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  client: vi.fn(),
  broadcast: vi.fn(),
  inspect: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, authTraveler: mocks.auth };
});
vi.mock("@/lib/db", () => ({ serviceClient: () => mocks.client() }));
vi.mock("@/lib/realtime", () => ({ broadcastTripUpdate: mocks.broadcast }));
vi.mock("@/lib/reservation-artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reservation-artifacts")>();
  return {
    ...actual,
    inspectReservationArtifact: mocks.inspect,
    retryReservationProofCleanup: mocks.cleanup,
  };
});

import { DELETE, GET, PATCH, POST, PUT } from "@/app/api/items/[id]/reservation/artifact/route";
import { TRIP_TOKEN_HEADER } from "@/lib/auth";
import { MAX_RESERVATION_ARTIFACT_BYTES } from "@/lib/reservation-artifacts";

const UPLOAD_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const params = { params: Promise.resolve({ id: "item-1" }) };

function request(method: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request("http://test/api/items/item-1/reservation/artifact", {
    method,
    headers: { "Content-Type": "application/json", [TRIP_TOKEN_HEADER]: "secret", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function query(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) builder[method] = () => builder;
  builder.maybeSingle = () => Promise.resolve(result);
  return builder;
}

function database(options: {
  row?: unknown;
  rpc?: (name: string) => { data: unknown; error: unknown };
} = {}) {
  const bucket = {
    createSignedUploadUrl: vi.fn().mockResolvedValue({
      data: { path: "trip-1/item-1/proof.pdf", token: "signed-upload-token" }, error: null,
    }),
    createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: "https://storage.test/signed" }, error: null }),
  };
  const rpc = vi.fn(async (name: string) => options.rpc?.(name) ?? (
    name === "begin_reservation_proof_upload"
      ? { data: { artifact_id: UPLOAD_ID }, error: null }
      : name === "finalize_reservation_proof_upload"
        ? { data: { outcome: "created" }, error: null }
        : name === "remove_reservation_proof"
          ? { data: { outcome: "removed", cleanup_job_id: JOB_ID }, error: null }
          : { data: null, error: null }
  ));
  return {
    db: {
      rpc,
      from: vi.fn(() => query({ data: options.row ?? null, error: null })),
      storage: { from: vi.fn(() => bucket) },
    },
    bucket,
    rpc,
  };
}

describe("reservation proof signed-transfer API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      trip: { id: "trip-1" },
      me: { id: "traveler-1", is_organizer: true },
    });
    mocks.cleanup.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
    mocks.inspect.mockResolvedValue({
      mediaType: "application/pdf",
      byteSize: 25,
      storageEtag: "server-etag",
      contentSha256: "a".repeat(64),
    });
    mocks.broadcast.mockResolvedValue(undefined);
  });

  it("issues an organizer-only direct upload for the full 8 MB product limit", async () => {
    const { db, bucket, rpc } = database();
    mocks.client.mockReturnValue(db);
    const response = await POST(request("POST", {
      slug: "example-coast", fileName: "booking.pdf", mediaType: "application/pdf",
      byteSize: MAX_RESERVATION_ARTIFACT_BYTES,
    }), params);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ upload: { id: UPLOAD_ID, token: "signed-upload-token" } });
    expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(expect.stringMatching(/\.pdf$/), { upsert: false });
    expect(rpc).toHaveBeenCalledWith("begin_reservation_proof_upload", expect.objectContaining({
      p_declared_byte_size: MAX_RESERVATION_ARTIFACT_BYTES,
    }));
    expect("upload" in bucket).toBe(false);
  });

  it("does not issue signed transfers to ordinary travelers", async () => {
    mocks.auth.mockResolvedValue({ trip: { id: "trip-1" }, me: { id: "traveler-2", is_organizer: false } });
    const { db, bucket } = database();
    mocks.client.mockReturnValue(db);
    const response = await POST(request("POST", {
      slug: "example-coast", fileName: "booking.pdf", mediaType: "application/pdf", byteSize: 10,
    }), params);
    expect(response.status).toBe(403);
    expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("keeps file payloads out of the Vercel route and rejects oversized declarations", async () => {
    const controlPayload = await POST(request("POST", {
      slug: "example-coast", fileName: "booking.pdf", mediaType: "application/pdf", byteSize: 10,
    }, { "content-length": String(5 * 1024 * 1024) }), params);
    expect(controlPayload.status).toBe(413);
    expect(mocks.auth).not.toHaveBeenCalled();

    const undeclaredOversizedControl = await POST(request("POST", {
      slug: "example-coast", fileName: "booking.pdf", mediaType: "application/pdf", byteSize: 10,
      padding: "x".repeat(17 * 1024),
    }), params);
    expect(undeclaredOversizedControl.status).toBe(413);

    const tooLarge = await POST(request("POST", {
      slug: "example-coast", fileName: "booking.pdf", mediaType: "application/pdf",
      byteSize: MAX_RESERVATION_ARTIFACT_BYTES + 1,
    }), params);
    expect(tooLarge.status).toBe(400);
  });

  it("finalizes from Storage-owned inspection data without accepting a client hash", async () => {
    const row = {
      id: UPLOAD_ID, storage_path: "trip-1/item-1/proof.pdf",
      declared_media_type: "application/pdf", status: "pending_upload",
    };
    const { db, rpc } = database({ row });
    mocks.client.mockReturnValue(db);
    const response = await PATCH(request("PATCH", { slug: "example-coast", uploadId: UPLOAD_ID }), params);
    expect(response.status).toBe(201);
    expect(mocks.inspect).toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("finalize_reservation_proof_upload", expect.objectContaining({
      p_storage_etag: "server-etag",
      p_byte_size: 25,
      p_content_sha256: "a".repeat(64),
    }));

    const untrustedHash = await PATCH(request("PATCH", {
      slug: "example-coast", uploadId: UPLOAD_ID, sha256: "client-supplied",
    }), params);
    expect(untrustedHash.status).toBe(400);
  });

  it.each([
    ["duplicate", "That proof is already attached"],
    ["stale", "Another proof replacement finished first"],
  ])("cleans up a %s finalization without replacing the current proof", async (outcome, message) => {
    const row = {
      id: UPLOAD_ID, storage_path: "trip-1/item-1/proof.pdf",
      declared_media_type: "application/pdf", status: "pending_upload",
    };
    const { db } = database({
      row,
      rpc: (name) => name === "finalize_reservation_proof_upload"
        ? { data: { outcome, cleanup_job_id: JOB_ID }, error: null }
        : { data: null, error: null },
    });
    mocks.client.mockReturnValue(db);
    const response = await PATCH(request("PATCH", { slug: "example-coast", uploadId: UPLOAD_ID }), params);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain(message);
    expect(mocks.cleanup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ jobIds: [JOB_ID] }));
  });

  it("issues a one-minute signed download only after organizer authorization", async () => {
    const row = { storage_path: "trip-1/item-1/proof.pdf", original_file_name: "private-name.pdf" };
    const { db, bucket } = database({ row });
    mocks.client.mockReturnValue(db);
    const response = await GET(new Request("http://test/api/items/item-1/reservation/artifact?slug=example-coast", {
      headers: { [TRIP_TOKEN_HEADER]: "secret" },
    }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: "https://storage.test/signed", fileName: "private-name.pdf" });
    expect(bucket.createSignedUrl).toHaveBeenCalledWith(
      row.storage_path, 60, { download: row.original_file_name },
    );

    mocks.auth.mockResolvedValue({ trip: { id: "trip-1" }, me: { id: "traveler-2", is_organizer: false } });
    const forbidden = await GET(new Request("http://test/api/items/item-1/reservation/artifact?slug=example-coast", {
      headers: { [TRIP_TOKEN_HEADER]: "secret" },
    }), params);
    expect(forbidden.status).toBe(403);
  });

  it("reports queued removal cleanup and provides an explicit retry endpoint", async () => {
    const { db } = database();
    mocks.client.mockReturnValue(db);
    mocks.cleanup.mockResolvedValueOnce({ attempted: 1, succeeded: 0, failed: 1 });
    const removed = await DELETE(request("DELETE", { slug: "example-coast" }), params);
    expect(removed.status).toBe(202);
    expect(await removed.json()).toEqual({ cleanupPending: true });

    mocks.cleanup.mockResolvedValueOnce({ attempted: 1, succeeded: 1, failed: 0 });
    const retried = await PUT(request("PUT", { slug: "example-coast" }));
    expect(retried.status).toBe(200);
  });
});
