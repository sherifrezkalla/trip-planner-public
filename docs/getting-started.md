# Beginner's guide

This guide is for someone using an already configured Trip Planner website. You do not need GitHub, a terminal, an AI agent, or your own API keys. Ask the person hosting the app for its address. There is no public hosted service promised by this repository.

## Join a trip

1. Open the private trip link from your organizer.
2. Enter the name the group knows you by, then choose your interests, pace, and dietary preferences.
3. Join the trip. You should see the shared board and traveler list.
4. Suggest a place or activity and vote when a change request appears.

Keep using the same browser. Your browser stores a private access credential. To move to another device, use the app's **Use on another device** flow and keep that resume link private. A normal trip invitation and an identity-restoring resume link are different; do not share the latter with other travelers.

## Organize a trip

1. Open your host's Trip Planner website and create a trip with its destination, dates, and budget.
2. Join as the organizer and enter your preferences.
3. Share the trip invitation directly with the people traveling with you. Anyone holding it can join.
4. Ask travelers to add their preferences before generating an itinerary.
5. Generate the plan and review the proposed places, timing, travel distances, and group fit.
6. Use the board to review suggestions, settle change requests, and record reservations you have actually made.

Success means the group can open the same board and see the shared plan. Generating a plan does not reserve or pay for anything.

## During the trip

Use **Today Mode** for the day's progress, next stop, maps, and weather context. Mark stops done or skipped. As organizer, preview a reshuffle or **Adjust today** before applying changes. Check live travel conditions and venue availability yourself; timing and AI recommendations are estimates.

For bookings, record confirmation only after the venue or booking provider has confirmed it. Keep contact details and proof attachments within the organizer controls.

## Optional: connect an assistant

The web app is useful on its own. If you already have OpenClaw or Hermes and a technical person to help, read [agent setup](agent-setup.md). The current connector setup is an advanced preview; selecting a provider does not install an agent or connect WhatsApp for you.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| The website does not load | Check the address and ask the host whether the installation is running. |
| The join form appears again | Use the original browser or your private resume link. Clearing browser data can remove your identity. |
| You cannot see organizer controls | Check that you are using your organizer identity rather than a newly joined traveler. |
| Generation or concierge fails | Ask the host to check provider configuration, billing/usage limits, and service availability. Reconnecting WhatsApp will not fix a model quota failure. |
| Maps are missing | Ask the host to check the browser Maps key and allowed website addresses. |
| A booking is shown but the venue has not confirmed it | Treat it as unconfirmed; contact the venue through the booking route. |
| An agent says it is paired but does not reply | Pairing is only one setup stage. Follow the readiness and real-message test in the agent guide. |

When reporting a problem, describe the action and error using a made-up trip. Do not paste your private trip/resume link, traveler token, real roster, or booking evidence into a public issue.
