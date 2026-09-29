export const RESERVATION_ARTIFACT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export type ReservationArtifactMediaType = (typeof RESERVATION_ARTIFACT_TYPES)[number];

export const MAX_RESERVATION_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_RESERVATION_ARTIFACT_CONTROL_BYTES = 16 * 1024;
export const RESERVATION_PROOF_BUCKET = "reservation-proofs";
export const RESERVATION_UPLOAD_URL_TTL_SECONDS = 2 * 60 * 60;
export const RESERVATION_DOWNLOAD_URL_TTL_SECONDS = 60;
