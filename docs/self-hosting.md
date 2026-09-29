# Host your own Trip Planner

This setup requires technical help: hosting, a database, provider accounts, and private configuration. There is no supported one-click installer yet. To use an existing installation, follow the [beginner's guide](getting-started.md).

## Before starting

You need your own repository copy, Node.js 24 and npm, a Supabase project, Google Cloud API access with billing, and model-provider API access. The current generation code supports Ollama and Anthropic; the concierge uses Ollama independently of the generation provider. Review provider pricing and set spending limits. The source license supplies no hosting, API credits, WhatsApp number, or shared database.

## 1. Get the source

Clone your repository copy, then run:

```sh
npm ci
cp .env.example .env.local
```

Fill `.env.local` privately. Never commit it or paste credentials into an issue, command argument, or screenshot. Template model names are examples; select models available to your own provider account. A consumer chat subscription does not necessarily include API access.

## 2. Prepare an empty database

Create a Supabase project. Using its SQL editor, apply **every** file in [supabase/migrations](../supabase/migrations) in filename order, starting with `0001_init.sql`. Run one file at a time and stop if one fails. Later migrations supply required access controls, database functions, limits, reservation storage policies, and the agent schema. Applying only the first file is insufficient.

Record which files were applied. Experienced operators may instead use migration tooling with an explicit migration ledger; reconcile that ledger before mixing manual and automated workflows. Do not blindly replay migrations against an existing database. Do not import a maintainer's production trip data.

## 3. Configure your services

Use `.env.example` as the starting template:

| Purpose | Variables | Required setup |
| --- | --- | --- |
| Server database | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Your own Supabase project; keep service-role access server-only. |
| Browser database | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The same project, using its public browser key and migrated access controls. |
| Venue search | `GOOGLE_MAPS_API_KEY` | Server key for Places API (New), restricted to the required API. |
| Maps | `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` | Separate Maps JavaScript API browser key, restricted to your website referrers. |
| Generation | `LLM_PROVIDER`, `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, `OLLAMA_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Choose an available model. Anthropic is the configured fallback; it cannot succeed without its own API access. |
| Concierge | `OLLAMA_CHAT_MODEL` and the Ollama variables | Ollama access is needed even if generation selects Anthropic. |
| Site address | `NEXT_PUBLIC_SITE_URL` | Your canonical origin, such as `https://planner.example.com`, without a path. |
| Optional driving routes | `GOOGLE_ROUTES_API_KEY` | Separate Routes API access and billing; absence produces an unavailable result. |
| Optional external agents | `TRIP_AGENT_IDENTITY_PEPPER`, `TRIP_AGENT_ALLOWED_HOSTS` | A stable server-only random secret and an explicit hostname allowlist. See [gateway architecture](architecture/trip-agent-gateway.md). |

For local maps, allow `http://localhost:3000/*` on your browser key. Add your production HTTPS domain before deployment. Do not copy another installation's hostname or keys. Optional Telegram setup is explained in [organizer alerts](architecture/organizer-alerts.md).

## 4. Test locally

```sh
npm run dev
```

Open `http://localhost:3000`. Use fictional travelers and a synthetic trip. Confirm that joining works, preferences save, maps load, generation succeeds, and the concierge answers. No actual booking is needed. Then run:

```sh
npm test
npm run lint
npm run build
```

Tests and builds do not require production secrets. A build does not verify database migrations, paid APIs, or message delivery. Keep other checkouts and scratch TypeScript files outside the source directory.

## 5. Deploy your own copy

In Vercel, import your GitHub repository as a **new** project. Use Next.js and Node.js 24. Set the production branch deliberately; this project's CI uses `master`. Configure the environment variables using your own migrated database and provider accounts.

Deploy, assign your own stable domain, update the canonical site URL and browser Maps restrictions, and redeploy after changing build-time `NEXT_PUBLIC_*` values. Repeat the synthetic trip checks on the deployed address.

Do not give untrusted preview deployments production credentials. Interactive previews require a separate backend and keys. Without them, treat previews as build-review artifacts whose database-backed routes are unavailable.

Neither CI nor Vercel applies database migrations automatically. Future changes must follow their documented migration/deployment order. Back up the database first; rolling back code does not undo database changes. Use a reviewed PR and confirm the deployed commit rather than deploying an unreviewed local branch over production.

## 6. Invite travelers

Once the web flow works, create a trip and share its invitation privately. The host manages infrastructure, costs, retention, and backups; travelers need only the website. Connecting Hermes or OpenClaw is a separate [optional advanced setup](agent-setup.md).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing database table or function | All migrations applied to the project used by both URL variables. |
| Blank map | Browser key, Maps JavaScript API, and allowed website referrers. |
| Venue search or generation fails | Places API access, billing, server key, and model-provider access. |
| Concierge fails while generation works | Ollama credentials and chat model; concierge does not switch with `LLM_PROVIDER`. |
| Local works but deployment fails | Environment scope, public build-time variables, schema, canonical URL, and provider quotas. |
| Agent paired but not replying | Model access, mappings, permissions, protocol compatibility, and group routing. |

Share variable names and redacted errors in support requests, never their values or real trip links.
