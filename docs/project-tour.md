# A fictional weekend with Trip Planner

Alex, Sam and Robin want to spend a weekend in Lisbon. They have different interests and want one plan they can change together. This walkthrough shows how Trip Planner helps them, from the first invitation to a changed afternoon.

**This is a made-up example, not a booking or a live shared demo.** You can read it without an account, API key, WhatsApp number or installation. To try the steps, use a website your host has configured, or ask a technical helper to follow [self-hosting](self-hosting.md). Use your own fictional trip; no maintainer trip or identity link is needed.

## 1. Create one shared trip

Alex creates **DEMO — Lisbon Weekend**, chooses 14–16 May 2027, a comfortable budget and city-only travel, and adds “relaxed walks, food and art” as the trip's vibe. On the join screen, Alex enters a fictional name and preferences.

The **first traveler to join becomes the organizer**. Join your own new trip before sharing its invitation. Keep that browser identity: the **Use on another device** option creates a private resume link, which is different from the invitation you send friends.

**What to look for:** the shared board, the trip's dates, the traveler list and organizer controls. An empty board is expected before generating a plan.

## 2. Let the group shape the plan

Sam joins from the invitation and chooses food and markets. Robin chooses history and art. They add place suggestions before Alex generates the itinerary.

To act out this example yourself, use a separate browser profile or private window for each fictional traveler. Do not clear the organizer's browser data or paste its resume link into another person's session. A private-window identity disappears when that window closes unless you save its private resume link.

**What to look for:** different travelers and preferences on the same board. The invitation allows its holders to join and edit, so keep your own trip's link within your intended group.

## 3. Generate and review together

Alex selects **Generate plan**. Trip Planner finds venue data through Google Places and asks a configured model to arrange it. The group reviews the dates, places, map and preference coverage.

The exact itinerary varies with venue data and model output. Generation needs working provider access and may incur the host's API costs. If it fails, the app should report a failure; this guide does not promise that a model or venue will always be available.

**What to look for:** a shared itinerary the group can discuss. Nothing is booked or paid for by generating it. Check opening hours, accessibility and availability before making real plans.

## 4. Make a group decision

Robin wants to move or remove a stop. A change request makes that decision visible to the group. Travelers can vote; the organizer can approve or turn it down. The accepted change updates the shared plan according to the app's decision rules. A request based on an outdated plan may be canceled rather than applied to the wrong activity.

For this example, keep changes within your fictional trip. Do not make a real reservation just to demonstrate the workflow.

**What to look for:** the request, its decision and the resulting itinerary, rather than a change hidden in a chat conversation.

## 5. Use the plan on the day

On the trip's dates, **Today Mode** focuses on progress and the next stop. Travelers can mark activities done or skipped. The organizer can preview a reshuffle or **Adjust today** before applying a revision. Supported repair flows preserve completed and protected activities.

The sample dates above are in the future; do not expect them to exercise a current-day workflow immediately. For a during-trip demonstration, create a separate fictional trip covering today's date. Weather, routing and venue information can be unavailable and should be treated as estimates, not guarantees.

## 6. Add an assistant only if you want one

The web workflow above works independently of WhatsApp. The organizer's **Trip agent** card offers five setup stages and a brief for an existing Hermes or OpenClaw assistant. The initial organizer screen is production-verified; full live-provider acceptance remains incomplete.

Copying a setup brief does not install, pair or activate an agent. Provider setup still needs a capable local assistant or operator, secure pairing, identity and permission review, and approval before group messaging. Trip Planner does not supply an agent account or hosted agent service. See [agent setup](agent-setup.md) when you are ready.

## What is available today?

| Area | Current boundary |
| --- | --- |
| Collaborative web planning | Trip creation, preferences, venue-based generation, suggestions and group decisions are implemented. A configured host and working APIs are needed. |
| During-trip tools | Today Mode, progress and supported preview/apply repair flows are implemented. Some behavior requires current trip dates and external data. |
| Reservations | Track real confirmations and private proof; assistance prepares a human handoff. No autonomous purchase or guaranteed reservation. |
| External assistants | Gateway and guided organizer setup are available as a preview. One Hermes read-only group conversation was verified; broader acceptance is deferred. |
| Hosted agent / automatic setup | Not provided. |
| Proactive WhatsApp monitoring, native polls and simplified mobile companion | Unfinished; not included in the current preview. |

[The roadmap](../ROADMAP.md) records detailed status. [The beginner guide](getting-started.md) covers everyday use and troubleshooting. [Contributing](../CONTRIBUTING.md) explains how to help improve the project.
