# Guided agent onboarding screenshots

Captured on 2026-09-30 from the actual organizer panel in a temporary local Next.js preview with synthetic state and callbacks. No live trip, account, pairing code, WhatsApp session, API mutation, or database was used. The temporary preview route was removed before the production build and commit. These images establish UI presentation, not provider compatibility or real WhatsApp behavior.

- [Desktop start](desktop.png) — default 1280 × 720 browser viewport.
- [Mobile start](mobile-start.png) — 390 × 844 viewport.
- [Pairing](mobile-pairing.png) — synthetic, explicitly invalid code.
- [Confirm identity](mobile-mapping.png).
- [Notice and permissions](mobile-notice.png).
- [Active connection](mobile-active.png) — optional first question, no implied test certification.
- [Uncertain request](mobile-uncertain.png) — refresh guidance and disabled mutations.

The tested mobile states had no horizontal page overflow. Provider selection changed the brief and advanced-help label; issuing a synthetic code advanced the guide and disabled changing providers while the code was valid. Copy produced the UI success status; the exact clipboard payload is covered by component tests, since the browser tool's clipboard read-back was inconclusive.
