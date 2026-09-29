# Security and privacy

## Report a vulnerability privately

Use the repository Security tab's private vulnerability reporting if the maintainer has enabled it. If unavailable, open a nonsensitive issue asking for a private contact channel. Do not publish exploit credentials, private trip links, or traveler data. No guaranteed response time is currently offered.

## Access model

Travelers use private bearer credentials stored in their browser rather than individual app accounts. A trip invitation grants joining access; a resume link restores a particular traveler's identity. Never share the organizer's resume link with travelers or agents.

Anyone holding a trip invitation can join. Tokens do not currently expire automatically. Legacy URL-based token forms remain accepted for compatibility; current clients use headers and fragments. See [traveler-token design](docs/architecture/traveller-tokens.md). Operators of self-hosted instances control the database and server credentials; choose an operator you trust.

## Protect credentials and data

Keep server database keys, model keys, messaging secrets, the agent identity pepper, and connector credentials in private server/provider storage. Only intended public configuration may use `NEXT_PUBLIC_`. Browser Maps keys still need API and referrer restrictions.

Use separate production and preview databases. Never give untrusted PR code production access. Keep agent memory, WhatsApp session files, environment files, transcripts, exports, and backups outside Git. Rotate exposed credentials at their provider; deleting a file does not invalidate them or erase history.

Depending on enabled features, preferences, itinerary context, questions, and venue queries may be sent to configured model, Maps/Places, weather, or messaging providers. Reservation proof is stored in the configured private Supabase bucket. Operators should disclose enabled providers and review their retention policies.

External agents retain data independently. Pausing/revoking a Trip Planner connector stops canonical app access; it does not delete the provider's history or disconnect other accounts.

## Publishing source safely

Use synthetic fixtures. Review tracked files, binaries, screenshots, Git history, commit identities, issues, PRs, attachments, workflow logs, and release assets before publication. `.gitignore` does not remove already tracked data. Follow the [public-release checklist](docs/public-release.md).

These guidelines and automated tests are not a security certification. Operators remain responsible for patches, access controls, backups, costs, and appropriate hosting configuration.
