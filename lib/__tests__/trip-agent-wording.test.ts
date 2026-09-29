import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  privacyNotice,
  TRIP_AGENT_GROUP_PROMPT,
  TRIP_AGENT_REPLY_FRAMES,
} from "@/lib/trip-agent-wording";

describe("trip agent wording", () => {
  it("preserves the exact v1 activation notice", () => {
    expect(privacyNotice("Alex")).toBe(
      "Hi — I’m the trip AI supplied by Alex. I can read the shared plan, answer trip questions, prepare or carry out permitted changes, and send important trip alerts. The organizer controls my access and can pause or remove me. I save structured trip facts, decisions, and action records—not unrelated group chat. Unmatched participants can ask questions but cannot change or vote on the plan.",
    );
  });

  it("keeps all group reply frames concise and explicit about outcomes", () => {
    expect(TRIP_AGENT_REPLY_FRAMES).toEqual({
      answer: "The shared plan says: <answer>.",
      research: "I found <options>. <source and date>. Availability and opening hours still need verification.",
      changePreview: "Proposed change: <change>. <impact>. Confirm to continue.",
      proposalOpened: "Proposal opened: <change>. <who must approve>. The plan has not changed yet.",
      confirmationNeeded: "I heard a possible plan: <candidate>. Should I prepare this change?",
      success: "The shared plan is updated: <change>.",
      refusal: "I can’t do that: <reason>. <allowed next step>.",
      staleAction: "That preview is out of date. I’ll check the plan and prepare a fresh preview for confirmation.",
      externalOutcomeUnknown: "I can’t confirm whether the provider completed this. Please check with the provider before trying again.",
      proactiveAlert: "Trip alert: <verified issue>. <time affected>. <suggested next step>.",
    });
    for (const frame of Object.values(TRIP_AGENT_REPLY_FRAMES)) {
      expect(frame.length).toBeLessThan(180);
      expect(TRIP_AGENT_GROUP_PROMPT).toContain(frame);
    }
  });

  it("ships the same canonical prompt in the copyable UI and connector guide", () => {
    const guide = readFileSync("docs/connectors/trip-agent-group-prompt.md", "utf8");
    expect(guide.trim()).toBe(TRIP_AGENT_GROUP_PROMPT);
  });

  it("documents the exact notice and distinguishes alert capability from readiness", () => {
    const guide = readFileSync("docs/connectors/trip-agent-privacy-notice.md", "utf8");
    expect(guide).toContain(privacyNotice("<organizer>"));
    expect(guide).toContain("v1");
    expect(guide).toContain("does not mean proactive alerts are running");
  });

  it("keeps identity, retry, and delivery boundaries in the reusable prompt", () => {
    expect(TRIP_AGENT_GROUP_PROMPT).toContain("Trip Planner is the source of truth");
    expect(TRIP_AGENT_GROUP_PROMPT).toContain("fresh UUID requestId for each logical request");
    expect(TRIP_AGENT_GROUP_PROMPT).toContain("reuse that same requestId on retry");
    expect(TRIP_AGENT_GROUP_PROMPT).toContain("commit_trip_change is the exception: pass the preview’s actionId, externalGroupId, and externalParticipantId; do not add requestId");
    expect(TRIP_AGENT_GROUP_PROMPT).toContain("never display names");
    expect(TRIP_AGENT_GROUP_PROMPT).toContain("visible outbound message ID");
    expect(TRIP_AGENT_GROUP_PROMPT).toContain("confirmed traveler");
    expect(TRIP_AGENT_GROUP_PROMPT).toContain("Do not claim proactive alerts are running");
  });
});
