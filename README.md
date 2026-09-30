# Trip Planner

Plan a trip together, make fair group decisions, and adapt the itinerary when the day changes.

Trip Planner is a collaborative web app for friends and families. An organizer creates a trip and shares a private link. Travelers add their interests, suggest places, and vote on changes. AI arranges real venue results into a plan; the organizer stays in control of important changes and bookings.

**You can use the web app without installing an AI agent or connecting WhatsApp.** Travelers do not need individual app accounts. Someone must first host and configure the application; this repository does not provide a public hosted service or a one-click installation.

This public repository starts from a reviewed source snapshot. Earlier private development history and its issue discussions are not included. Historical validation notes describe maintainer checks before this release; current checks are available in this repository’s Actions tab.

## Start here

| Your goal | Read this |
| --- | --- |
| Join or organize a trip on an existing installation | [Beginner's guide](docs/getting-started.md) |
| Run your own private installation | [Self-hosting guide](docs/self-hosting.md) — technical setup required |
| Connect your existing assistant | [Agent setup overview](docs/agent-setup.md) — optional, guided preview |
| Contribute code, documentation, or a bug report | [Contributing](CONTRIBUTING.md) |
| Understand access and data handling | [Security and privacy](SECURITY.md) |

## What you can do

- **Build a shared itinerary.** Choose dates, destination, budget, travel radius, pace, and interests. Generate a plan grounded in Google Places venues.
- **Make group decisions.** Suggest activities, vote on proposed changes, and let the organizer approve or reject them. See how well the plan covers different travelers' interests.
- **Use the plan during the trip.** Today Mode shows the next stop, progress, maps, weather, and planning estimates. Mark activities done or skipped.
- **Adapt safely.** Preview schedule changes, adjust the rest of today, or ask for alternatives. Completed and protected activities are preserved by the supported repair flows.
- **Track reservations.** Record booking status, confirmation details, deadlines, and private proof attachments. Reservation assistance helps prepare a handoff; it does not autonomously buy or confirm a booking.
- **Ask trip questions.** The in-app concierge uses itinerary context and venue research. Model-provider access is required for AI features.
- **Connect optional tools.** Organizer Telegram alerts are available. OpenClaw and Hermes connectors are operator previews with limited live-provider verification.

See the [roadmap](ROADMAP.md) for shipped features and unfinished work, and [product strategy](docs/product-strategy.md) for the project's direction.

## Scope and limitations

Trip Planner focuses on coordinating a group and keeping a shared plan useful during travel. It is not a travel agency, booking marketplace, guaranteed reservation service, or autonomous payment agent. Verify opening hours, accessibility, availability, weather, and booking terms before relying on them.

AI results can be wrong or unavailable. Hosting, Google APIs, and model providers may charge separately; an open-source license does not include those services. A paid consumer AI subscription is not automatically an API credential.

WhatsApp is **not** automatically connected by deploying this app. Bring-your-own-agent setup now has guided steps and a credential-free setup brief. A capable local assistant or technical operator still configures the provider. The gateway and organizer setup UI are implemented, but full real-group behavior is not certified for either provider. Native polls, proactive monitoring, and the simplified mobile companion remain unfinished. See [agent setup](docs/agent-setup.md).

## Run locally

Requires Node.js 24 and npm, a configured Supabase project with **all migrations applied**, Google API credentials, and model-provider access for AI features. Follow [self-hosting](docs/self-hosting.md) before expecting database-backed features to work.

```sh
git clone https://github.com/sherifrezkalla/trip-planner-public.git trip-planner
cd trip-planner
npm ci
cp .env.example .env.local
# Fill .env.local privately; never commit it.
npm run dev
```

Open [localhost:3000](http://localhost:3000). Run checks with:

```sh
npm test
npm run lint
npm run build
```

Tests and production builds run without real trip data or production credentials. Keep other checkouts and scratch files outside this directory so they do not enter TypeScript's source scan.

## Technical overview

Next.js and React provide the web interface and server routes. Supabase stores trip state and reservation attachments. Google Places supplies venue data; configurable model providers arrange itineraries and answer questions. Trip access uses private bearer credentials rather than individual logins.

Start with [the documentation index](docs/README.md). Architectural decisions live in [docs/architecture](docs/architecture), schema changes in [supabase/migrations](supabase/migrations), and sanitized historical design proposals in [docs/superpowers](docs/superpowers). Historical plans describe intent at the time; the roadmap and current guides describe current support.

## Privacy when sharing

A trip link allows people to join that trip. A resume link restores a traveler's identity. Neither belongs in a public issue, screenshot, or repository. Keep real rosters, booking references, contact details, trip exports, credentials, and agent sessions outside source control. Example fixtures must be synthetic. See [SECURITY.md](SECURITY.md).

Making this source public does not publish a separately hosted database, but committing an export, private link, screenshot, or credential can expose its contents or access. Maintainers should follow the [public-release checklist](docs/public-release.md) before changing repository visibility.

## License

[MIT](LICENSE). Third-party services and dependencies have their own terms and licenses.
