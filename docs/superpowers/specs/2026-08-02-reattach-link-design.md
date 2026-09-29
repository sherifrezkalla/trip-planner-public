# Re-attach link — Design

**Date:** 2026-08-02
**Status:** Approved
**Author:** Trip Planner contributors

## 1. Purpose

Identity is currently tied to one browser: joining writes `localStorage["tp:{slug}"] = token`, and nothing can move it. Opening a trip on a second device shows the join form, and joining again creates a *different* traveller who is not the organiser. For someone who uses several devices this is a daily obstacle, not an edge case.

This gives a traveller a way to be themselves on any device.

**Success criteria:**
- Opening your personal link on a new device makes that device you, with your role and votes intact.
- The link that restores identity is visibly distinct from the link that invites others.
- A wrong or revoked token fails with a clear message, never a silent half-login.
- Nothing changes for people who only ever use one device.

## 2. Approach

The traveller token already *is* the identity; it simply cannot travel. A **re-attach link** carries it:

```
/t/{slug}/resume?k={token}
```

Opening it validates the token, stores it on that device, and continues to the board.

Rejected alternatives:
- **A master link across all trips** — one leak would expose every trip a person belongs to. Per-trip scope keeps the blast radius to one trip.
- **A transfer code or QR between devices** — needs the old device present, and must be repeated per device *and* per trip.
- **Full passwordless accounts** — the correct long-term answer and still open to us, but it rewires joining and authorisation throughout the app. Email delivery on top of this link (§7) reaches most of the benefit for a fraction of the change.

## 3. Validation

No new endpoint. The page calls the existing `GET /api/trips/{slug}?token={k}`:

| Result | Behaviour |
|---|---|
| `200` | Store the token, replace the URL with `/t/{slug}`, render the board |
| `401` | "This link is no longer valid" plus a button to join as someone new |
| `404` | "This trip doesn't exist any more" |
| network / other | Error with a retry; nothing is stored |

Storing only after a successful fetch means a bad token can never leave a device half-attached.

The URL is replaced rather than pushed, so the token does not linger in the address bar, is not copied out of it by accident, and does not become a back-button destination. It does still enter browser history and any link preview of the raw URL — accepted, and the reason the UI labels it private.

## 4. Security

The link is a bearer credential: whoever opens it **becomes that traveller on that trip** — voting as them and, for an organiser, regenerating the plan or removing travellers.

Mitigations are presentational, because the mechanism is inherently a secret URL:
- The **join link** (`/t/{slug}`) stays the primary, obviously shareable thing.
- The **re-attach link** is behind a "Use on another device" button, shown with a plain warning that it is private and must not go in the group chat.
- The resume route is `noindex`, like the board.

Confusing the two links is the one way this feature causes harm, so the wording on screen is part of the design, not decoration.

## 5. Architecture

| Unit | Responsibility |
|---|---|
| `lib/resume.ts` | **new** — `RESUME_PARAM`, `buildResumeUrl(origin, slug, token)`, `parseResumeToken(search)` |
| `app/t/[slug]/resume/page.tsx` | **new** — thin client page: validate, store, redirect; `noindex` |
| `components/TripBoard.tsx` | "Use on another device" panel with the link, a copy button and the warning |

Join, voting, permissions and the token model are untouched.

## 6. Testing

`lib/__tests__/resume.test.ts`:
- `buildResumeUrl` produces `/t/{slug}/resume?k={token}` against a given origin and URL-encodes the token.
- `parseResumeToken` returns the token from a query string, and `null` when the parameter is absent or empty.
- A token containing URL-significant characters survives a build → parse round trip.

Full suite, types and production build stay green.

## 7. Out of scope

Email delivery of the link (the next layer, once a sending domain exists); rotating a token to revoke old devices; identity that spans *trips* rather than living per trip.
