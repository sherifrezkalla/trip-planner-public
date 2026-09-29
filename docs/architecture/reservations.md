# Reservation Reliability Architecture

## Goal

Make booked activities a trustworthy safety boundary for group planning. A traveler should be able to answer:

- Is this activity tentative, confirmed, or cancelled?
- What exact time is booked and where is the confirmation?
- When does the cancellation window close?
- Can an automated plan change move or remove this activity?

## Data model

Reservation data lives on `itinerary_items` because the booking protects a specific venue in a specific itinerary slot.

- `reservation_status`: `none`, `tentative`, `confirmed`, or `cancelled`
- `reservation_at`: exact booking time; required for confirmed reservations
- `confirmation_number` and `booking_url`: optional retrieval details
- `cancellation_deadline`: optional deadline used for visible risk escalation
- `reservation_auto_locked`: distinguishes a reservation-owned lock from an organizer's manual lock
- `reservation_details_source`: records whether details came from organizer knowledge or were transcribed from evidence
- `reservation_organizer_verified_at/by`: records explicit organizer verification, never an automated inference

`reservation_proof_artifacts` stores one active artifact per itinerary item plus provisional and retired rows needed to finish or audit a transfer. It records the uploader and timestamp, the organizer-only original filename, declared and inspected media metadata, the opaque private Storage path, the Storage-owned ETag, a server-computed SHA-256 content digest, the active artifact observed when an upload began, and lifecycle state (`pending_upload`, `active`, `pending_delete`, or `deleted`). The file lives in the non-public `reservation-proofs` bucket. Raw paths, ETags, and digests are never returned in trip data.

`reservation_proof_cleanup_jobs` is the durable deletion ledger. It retains the object path, artifact and trip provenance, reason, attempt count, last error, retry time, and completion time. A failed Storage deletion therefore leaves a reachable, auditable job rather than removing the only metadata that can find the private object.

The cancellation index covers only tentative and confirmed reservations with a deadline. No reservation field is exposed publicly; data is returned only after the existing trip-member token check.

## Update and lock rules

Only the organizer can change reservation data. The API re-authenticates the trip token, applies the organizer gate, then calls `update_itinerary_reservation`.

The database function locks the trip and activity rows before changing them and independently verifies that the actor is the trip organizer. It then applies the reservation fields and lock state in one transaction.

- Tentative and confirmed reservations protect the activity from regeneration, swaps, reshuffles, partial-day moves, and skips.
- A confirmed reservation must include an exact date and time.
- A confirmed reservation must also include a confirmation reference or explicit organizer verification. Attaching evidence alone never satisfies this rule.
- If an activity already has a manual lock, saving a reservation preserves that lock as manual.
- Cancelling or removing a reservation releases only an automatic reservation lock. It never clears a separate manual lock.
- Completing a reserved activity preserves its reservation history. Undoing completion restores protection while the reservation remains active.

Existing schedule mutations continue to rely on `is_locked`; database constraints guarantee that every planned active reservation is locked.

## Cancellation awareness

`lib/reservations.ts` classifies active cancellation deadlines:

- passed: deadline already expired
- urgent: within 24 hours
- soon: within 72 hours
- later: visible formatted deadline

Warnings are deterministic display guidance. V1 does not send notifications or claim that a provider will honor a deadline.

## Today Mode

The next-activity card shows the reservation status, exact time, protection state, and cancellation warning. Leave-by guidance uses the exact tentative or confirmed reservation time when present; otherwise it falls back to the semantic itinerary block.

## Proof artifacts and privacy

Only the organizer may request an upload, finalize it, replace or remove an active proof, retry cleanup, or request a download. The bucket has no client access policy and is never public. A successful organizer check produces only a short-lived grant for one opaque object path: Supabase signed upload tokens expire after two hours, while download URLs expire after one minute. Ordinary trip members never receive either grant.

The transfer is deliberately split into small control requests:

1. The organizer sends the filename, browser-observed type, and size. The API authorizes the organizer and activity, creates a `pending_upload` row, and returns an object-specific signed upload token.
2. The browser uploads directly to Supabase Storage. Upload bytes never enter Function ingress, preserving the 8 MB product limit despite Vercel's 4.5 MB Function payload ceiling.
3. The organizer finalizes with only the provisional artifact id. The service reads Storage-owned size, content type, and ETag, then streams that private object once through a short-lived internal URL. The stream is capped at the inspected size and 8 MB, uses the first 1 KiB to require the expected JPEG, PNG, WebP, or PDF signature, and computes SHA-256 on the server. It rejects missing, empty, mismatched, changing, or over-8-MB objects. No client-supplied digest is accepted.
4. PostgreSQL atomically activates the inspected row. The server-computed SHA-256 plus inspected byte size is the duplicate fingerprint.

All control bodies are capped at 16 KiB. Downloads follow the same boundary: after organizer authorization, the API returns a one-minute private signed URL and the browser downloads from Storage directly. The API response is `private, no-store` and contains the original filename only because the caller has already passed the organizer gate.

Trip members see media type, byte size, upload time, uploader, and verification state but cannot download the potentially sensitive file. They do not receive the original filename, private path, ETag, digest, signed URL, or signed token. Service-role access remains behind the server authorization checks.

## Replacement, concurrency, and cleanup

Beginning an upload snapshots the current active artifact id. Finalization locks the trip and pending row, then compares that snapshot with the active artifact under the same transaction. If another replacement finished first, the losing upload becomes `pending_delete` and receives a cleanup job; it cannot displace the winner. The partial unique index still permits only one active proof per activity.

A successful replacement makes the new proof active and the old proof `pending_delete` in the same transaction, then records the old path in a cleanup job before Storage deletion is attempted. Removal uses the same ordering. Duplicate uploads, failed validation, failed signed-URL issuance, stale replacements, and expired unfinished uploads also retain an artifact row and cleanup job. The current proof is therefore never deleted before its replacement is active, and a failed deletion never makes the old object unreachable.

Cleanup is idempotent and retryable. Every artifact endpoint opportunistically enqueues expired uploads and processes due jobs; organizers also see a queued-cleanup indicator and can request an immediate retry. Failed attempts retain the error and use bounded exponential backoff. If Storage deletion succeeds but recording completion fails, the pending job is retried; deleting an already-absent object is safe and completion then closes the audit row.

This MVP does not OCR or interpret artifacts. Fields marked as transcribed remain visibly unverified until the organizer explicitly verifies the reservation. Evidence never changes authorship and never means “booked by the assistant.” Conflicting times and missing fields are left for the organizer to resolve rather than guessed.

Active retention is manual: a proof remains until the organizer replaces or removes it. Unfinished signed uploads expire after two hours and become cleanup candidates. The signature check is content-type validation, not antivirus scanning or full image/PDF parsing. Legal holds, OCR, and per-field extraction provenance are not included. The current 8 MB direct upload uses Supabase's standard signed-upload flow; if the product limit grows, resumable uploads should replace it.

## Migration, deployment, and rollback order

PR #73 is intentionally additive and merged before reservation-assistance PR #72. PR #72 is now rebased onto that merged master:

1. Apply `20260824212000_reservation_proof_artifacts.sql` before deploying PR #73. It creates the private bucket, artifact state tables and functions, the ten-argument reservation RPC, and a compatible eight-argument wrapper for the already-deployed reservation UI.
2. Confirm the bucket remains private, the new functions are executable only by `service_role`, and the reservation route saves through the ten-argument RPC. Then deploy the merged PR #73 application.
3. PR #72's later `20260826103000_reservation_assistance.sql` calls the ten-argument RPC with `detailsSource: "organizer"` and `organizerVerified: false`; its required provider reference grounds confirmation while preserving the existing lock semantics. The eight-argument wrapper remains available only for rollback compatibility.
4. Apply PR #72's migration before merging/deploying its application code.

For an application rollback, restore the pre-#73 deployment first; the eight-argument wrapper keeps that code compatible with the additive schema. Do not drop the bucket, lifecycle rows, cleanup ledger, or RPCs while private objects or pending jobs exist. A schema rollback requires first disabling new proof transfers, completing or explicitly exporting all pending cleanup records, removing retained objects through the service path, and backing up audit metadata. If PR #72 has landed, roll it back before removing #73's compatibility wrapper or reservation columns.

## Boundaries

- Proof attachments are evidence, not provider verification or a claim that the assistant booked the reservation.
- Cancellation reminders are visible in-app only; automated notifications are planned for v2.
- The app does not contact booking providers or verify reservation status.
- Flight and hotel import remain outside this activity-level reservation model.
