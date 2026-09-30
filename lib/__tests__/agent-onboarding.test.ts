import { describe, expect, it } from "vitest";
import { agentSetupBrief, installationMcpUrl } from "../agent-onboarding";

describe("agent setup handoff", () => {
  it.each(["hermes", "openclaw"] as const)("targets the chosen %s provider and installation without embedding access", provider => {
    const brief = agentSetupBrief(provider, "https://planner.example/");
    expect(brief).toContain("https://planner.example/api/mcp");
    expect(brief).toContain(`/docs/connectors/${provider}-whatsapp.md`);
    expect(brief).toContain("agent-assisted-setup.md");
    expect(brief).not.toContain("Bearer ");
    expect(brief).not.toContain("/t/");
    expect(brief).toContain("not chat, command arguments, logs or screenshots");
    expect(brief).toContain("Before any group message or activation, ask for my explicit approval");
    expect(brief).toContain("Never reset a session");
    expect(brief).toContain("conversation check deferred");
  });
  it.each([undefined, "", "http://planner.example", "https://user:secret@planner.example", "https://planner.example/t/private", "https://planner.example?token=secret", "https://planner.example#secret", "https://planner.example/api/mcp"])("refuses unsafe installation configuration %s", value => {
    expect(() => agentSetupBrief("hermes", value)).toThrow();
    expect(() => installationMcpUrl(value)).toThrow();
  });
  it("normalizes only a configured HTTPS origin", () => {
    expect(installationMcpUrl(" https://planner.example:8443/ ")).toBe("https://planner.example:8443/api/mcp");
  });
});
