# Guided agent onboarding

Status: app-side guided setup implementation; deployment and production UI verification on a selected installation remain pending. Live-trip acceptance tests are deferred, not passed. Provider installation remains outside the web app.

## Problem and behavior

The previous card led with configuration templates, pairing terminology, and status fields. Organizers had to infer which action belonged in the app, the assistant, or WhatsApp. The guided card now presents five stages derived from the existing server-confirmed lifecycle: choose assistant, connect privately, choose group, confirm access, and start chatting. It describes the next action, keeps connection details and configuration behind disclosure controls, and explains what to do without an existing agent.

The organizer can preview and copy a setup brief for the chosen provider. Its only installation-specific value is the explicitly configured HTTPS origin. It contains neither trip identity nor a pairing code, bearer, organizer token, group ID, or roster. There is no copy-and-activate action: the code is still generated separately when the assistant/operator is ready, and existing APIs enforce pairing, identity confirmation, permissions, and actual notice-receipt submission.

The paired provider is fixed while an unexpired code is in use, so an organizer cannot accidentally give instructions for a different provider with the same code. An uncertain request hides stage progress and directs a refresh. A refreshed page cannot recover a code lost from memory. A connection marked active offers a first-question prompt, but neither copying it nor deferring it records a successful live conversation.

## Trust and provider boundary

The brief directs a capable local assistant to inspect the installed runtime, preserve WhatsApp sessions and unrelated workflows, collect the code outside chat/transcripts/logs, and obtain approval before group messaging or activation. An assistant without secure local setup capabilities must hand off to its operator. These instructions are guidance, not enforcement of third-party behavior. No provider account credentials are collected by the app, no arbitrary script is downloaded or executed by the browser, and no new authority is granted.

The canonical installation origin is validated before producing a brief or template. HTTP, embedded credentials, paths, query parameters, and fragments are rejected. The app never derives a handoff endpoint from the current private trip URL. An unconfigured host sees an actionable message and no copy button for either brief or template.

Hermes templates include stateless MCP transport and scoped quiet WhatsApp display defaults. The installed runtime must support those settings; the operator must merge them, not replace an existing configuration. Other profiles are unaffected by the recommendation.

## Alternatives and limitations

A hosted-agent service or automatic remote installer would require ownership of account provisioning, secret exchange, session recovery, and supported provider versions. Those are deliberately not implied by this UI. A prompt containing a pairing code would simplify copying but would expose a live capability to chat retention; instead, pairing remains a separate secure local input. Self-reported completion checkboxes were rejected because they could claim activation without server evidence.

The UI does not independently observe WhatsApp delivery or certify provider behavior. The existing gateway stores connector receipt assertions; real group verification remains a separate milestone. One read-only Hermes conversation was verified on 2026-09-30. Broader live-trip actions, votes, recovery behavior, and quiet-reply presentation tests are deferred to a live trip.

## Validation, deployment and rollback

Unit and component tests cover unsafe origins, credential-free clipboard content, provider locking during pairing, lifecycle progression, uncertain-state recovery, optional conversation checks, and quiet Hermes templates. Synthetic browser checks exercise the organizer flow at desktop and mobile sizes. Screenshots are listed in [the guided setup gallery](images/guided-agent-onboarding/README.md).

No API or schema migration is required. Build with the installation's own `NEXT_PUBLIC_SITE_URL`. The public repository is independently deployable; merging here does not change an existing deployment linked to another repository. Deploy and verify the organizer card before marking this iteration shipped. Rollback reverts the UI/helper/template changes through a PR; existing connections, credentials, permissions and WhatsApp sessions remain under their original lifecycle controls.
