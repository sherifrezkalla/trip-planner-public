# Gateway foundation release evidence

Verified on 2026-09-22. Scope: Plan 1, the organizer-owned gateway foundation. Live WhatsApp/provider onboarding, proactivity, and the mobile companion remain Plans 2–4.

## Code and CI

- PR #87 (private development record), merged as `420d339bd2b1f9f2eaed63a74264d4e9cc9b0fac`.
- Clean installation, 76 test files / 1,156 tests, TypeScript, lint, and production build passed locally. An incomplete optional-dependency lockfile was repaired using the CI npm version, then clean-install checks were repeated.
- PR test/lint/build CI (private development record) and PostgreSQL 16 contention CI (private development record) passed. The database lane covers stale votes/rosters, competing settlements, quota concurrency, mapped-traveler removal, and concurrent connection creation.
- Both checks passed again on merged master: test/lint/build (private development record), PostgreSQL contention (private development record).
- Independent reviews and scoped fixes resolved lifecycle isolation, bot authority, durable setup replay, live settlement verification, credential transport, organizer aggregates, failure/retry contracts, and limiter contention.

## Production migrations

Applied only these reviewed files through the Supabase migration API, in this order:

| Repository file | Recorded production version | SHA-256 |
|---|---|---|
| `20260829120000_trip_agent_gateway.sql` | `20260922193417` | `845505fb5a9c15b7314f95ecbd0c7062f8f3ecdaa113d8fda1470669296a4cc6` |
| `20260921120000_gateway_safe_traveler_removal.sql` | `20260922193438` | `ef31c07ca76c9e50bc9ec2b74b7ed5e473db91cfe63f9d705dee58876b9579b1` |

The API assigns execution-time versions. Earlier production migration timestamps also differ from repository filenames. Do not use blanket `supabase db push` or replay these files: consult the recorded name/version mapping and installed catalog first. This release does not repair historical migration metadata.

All four gateway tables have RLS enabled and deny direct anonymous/authenticated access. Sensitive gateway and guarded-settlement/removal functions are unavailable to anonymous/authenticated roles; required service-role grants were verified. The security advisor reported only the expected informational “RLS enabled, no policy” finding for server-only tables (19 existing + 4 gateway), with no warning/error findings. [Advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).

The stable production alias served the merged SHA above, deployment the verified deployment. Required connector configuration was present and pairing returned the canonical `https://your-trip-planner.example/api/mcp` URL. No credentials are recorded here.

## Live smoke verification

A uniquely identified disposable trip with one organizer and one synthetic itinerary item passed:

1. Organizer join API and single-use connector pairing.
2. Official modern MCP initialization and exact twelve-tool inventory.
3. Group registration, organizer-confirmed mapping, exact scope grant, readiness, and activation.
4. Unmatched participant group-safe context, including a private-note leakage sentinel.
5. Unmatched move refusal with no action/proposal/suggestion or itinerary write.
6. Organizer preview and move commit; exact replay returned byte-identical structured content, one action execution, one applied proposal, and one canonical move.
7. Revocation immediately rejected the old bearer with HTTP 401.

The synthetic activation receipt exercised the gateway contract; no WhatsApp message, external booking, or provider onboarding was performed. Tokens and external identifiers stayed in process memory. Guarded cleanup matched the exact test trip ID, slug, title, and creation timestamp, refused unexpected reservation/proof data, and verified deletion plus trip-owned cascades. No real trip was changed. Shared public limiter entries retain their normal bounded expiration.

## Shipped limitations

- No live OpenClaw/Hermes/WhatsApp setup UI or provider adapter yet.
- No proactive engine or replacement mobile interface.
- Routes API key is absent; live traffic research reports unavailable.
- Today uses UTC until destination time zones are persisted.
- Reservation preparation creates a privately approved internal draft; it does not book, pay, or cancel.
- Uncertain claimed mutations remain terminal for automatic execution and may require reconciliation; exact durable replays can recover recorded outcomes.

Design alternatives and their constraints, including bearer transport, lifecycle generations, guarded settlement, and at-most-once recovery, are documented in [gateway architecture](trip-agent-gateway.md).
