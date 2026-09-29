# Public-source readiness

## Purpose and boundary

The source should explain what the app does, how travelers use it, and what an operator must configure. Publishing source is distinct from publishing a hosted database, private development history, or messaging sessions.

The README routes readers to a beginner guide, self-hosting guide, optional agent overview, contribution guide, and security guidance. The roadmap distinguishes implemented features from previews and proposed work. A license file supplies the MIT terms already identified by the project.

## Privacy design

Tests use fictional identities and dates while preserving relevant boundary conditions. Private session notes and obsolete scratch screenshots are excluded. The retained connector screenshot gallery documents its synthetic inputs. Configuration examples use placeholder origins and empty secrets. Public geographic knowledge is not itself private data, but examples must not reconstruct a real person's trip.

The connector configuration UI requires an explicit canonical installation address instead of falling back to a maintainer deployment. If it is missing or invalid, the UI explains how to configure it and offers no template to copy. The backend's existing Vercel fallback is unchanged. Telegram webhook registration requires an explicit URL for the installation. Neither path redirects new hosts to a maintainer's service.

## Alternatives and limitations

Replacing today's files cannot erase previous Git objects, PR discussions, screenshots, workflow logs, or commit identities. A clean source-only export into a new repository is the preferred publication boundary when the old history contains personal material. Retaining history requires a separate coordinated scrub, with the owner approving destructive changes and visibility changes.

A no-code installer was not added. Hosting still requires database migrations, provider accounts, and private settings. External agent onboarding remains an advanced operator preview; changing documentation does not certify WhatsApp behavior or provide agent hosting.

Secret scanning, pattern review, screenshot inspection, and tests reduce risk but cannot prove that all possible personal data is absent. Detailed findings and the publication decision stay outside the public source. Follow the [public-release checklist](../public-release.md).

## Validation and rollback

Run tests, lint, build, a redacted secret scan, source-pattern review, and documentation-link checks. Check a source export independently from the private Git history. Endpoint tests cover missing/invalid configuration and a host's own canonical origin; attendance tests retain a genuine month boundary after anonymization.

No database migration is needed. Configure `NEXT_PUBLIC_SITE_URL` and rebuild to generate provider templates. Existing server-side connections and WhatsApp sessions are unchanged. Roll back individual functional changes if needed; do not restore private notes or real fixtures into a public repository. The original private history remains available to authorized maintainers.

## Public repository boundary

The public repository is initialized from the reviewed source archive with fresh Git history and a GitHub noreply commit identity. It imports no private issues, pull requests, Actions logs, deployment integration, environment settings, or database contents. Setup and connector guide links target the public repository. Historical validation records remain as sanitized prose, without inaccessible private GitHub links.
