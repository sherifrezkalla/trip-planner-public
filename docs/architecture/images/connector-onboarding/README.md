# Connector onboarding screenshots

Captured 2026-09-25 from the production-built app with intercepted, **synthetic** board and connector responses. These demonstrate UI states, not real WhatsApp delivery or provider compatibility. No live account, credential, participant, or trip data appears. The rotation field is additionally masked.

Mobile viewport: 390 × 844; each image captures the full setup card. No page-level horizontal overflow was observed. A traveler board did not render the card. Rotation masking/dismissal and 403 metadata removal were exercised in the browser; reducer/render tests cover the lifecycle edge cases.

[Desktop screenshot](desktop.png): 1280 × 900 viewport, 736px card, no horizontal overflow. A stalled request recovered after its 20-second timeout: refresh became available, mutation controls stayed disabled, and no automatic retry occurred.

| State | Screenshot |
| --- | --- |
| Not connected | [none](none.png) |
| Pairing pending (code not retained) | [pairing](pairing.png) |
| Paired, awaiting group | [paired](paired.png) |
| Confirm organizer mapping | [mapping](mapping.png) |
| Review permissions | [authority](authority.png) |
| Privacy notice, awaiting actual receipt | [notice](notice.png) |
| Active | [active](active.png) |
| No recent contact | [offline](offline.png) |
| Failed announcement | [delivery](delivery.png) |
| Paused | [paused](paused.png) |
| Credential rotated, field masked | [rotation](rotation.png) |
| Revoked | [revoked](revoked.png) |
| Archived | [archived](archived.png) |
| Organizer access lost | [access denied](access-denied.png) |
