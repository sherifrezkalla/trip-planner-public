import { describe, expect, it } from "vitest";
import { connectionSetupStep, connectionHealth, setupReducer, initialSetupState, providerConfiguration, type AgentConnection, type AgentSnapshot } from "../trip-agent-setup";
import toolNames from "../trip-agent-tool-names.json";

const now = Date.parse("2026-09-23T12:00:00Z");
const connection: AgentConnection = {
  id: "connection", provider: "openclaw", status: "paired", lifecycleGeneration: 1,
  pairingExpiresAt: null, grantedScopes: ["connector.setup", "trip.read"],
  authorityPolicy: { travelerCanAddSuggestion: true, travelerCanProposeChange: true },
  agentPhoneE164: null, whatsappGroupLabel: null, groupRegistered: false, privacyNoticeDelivered: false,
  lastSeenAt: null, pairedAt: "2026-09-23T11:59:00Z", activatedAt: null, pausedAt: null,
  revokedAt: null, archivedAt: null, createdAt: "2026-09-23T11:58:00Z", updatedAt: "2026-09-23T11:59:00Z",
};
const snapshot = (c: AgentConnection | null = connection): AgentSnapshot => ({ connection: c, mappings: [], recentActions: [] });

describe("provider config templates", () => {
  it.each(["openclaw", "hermes"] as const)("generates %s with placeholders and an explicit exact tool list", provider => {
    const snippet = providerConfiguration(provider, "https://planner.example/api/mcp");
    expect(snippet).toContain("Bearer <TRIP_AGENT_CREDENTIAL>");
    expect(snippet).toContain("<GROUP_JID>");
    for (const name of toolNames) expect(snippet).toContain(name);
    expect(snippet).not.toContain('"*"');
    expect(snippet).not.toContain("WHATSAPP_ALLOWED_USERS=*");
  });
  it("keeps Hermes stateless and WhatsApp replies quiet in the operator template", () => {
    const config = providerConfiguration("hermes", "https://planner.example/api/mcp");
    expect(config).toContain("protocol: stateless");
    expect(config).toContain('tool_progress: "off"');
    expect(config).toContain("interim_assistant_messages: false");
    expect(config).toContain("show_reasoning: false");
  });
  it("uses the current OpenClaw toolFilter and group prompt keys", () => {
    const config = JSON.parse(providerConfiguration("openclaw", "https://planner.example/api/mcp", "123-456@g.us"));
    expect(config.mcp.servers["trip-planner"].toolFilter.include).toEqual(toolNames);
    expect(config.channels.whatsapp.groups["123-456@g.us"].requireMention).toBe(false);
    expect(config.channels.whatsapp.groups["123-456@g.us"].systemPrompt).toContain("Trip Planner");
  });
  it("rejects credentials, insecure URLs and group config injection", () => {
    for (const endpoint of ["http://planner.example/api/mcp", "https://secret@planner.example/api/mcp", "https://planner.example/api/mcp?token=secret"]) expect(() => providerConfiguration("hermes", endpoint)).toThrow();
    for (const group of ["*", '123@g.us\nfoo: secret', '123@g.us"']) expect(() => providerConfiguration("openclaw", "https://planner.example/api/mcp", group)).toThrow();
  });
});

describe("connection setup progression", () => {
  it("starts disconnected", () => expect(connectionSetupStep(null, null)).toBe("not_connected"));
  it.each(["paused", "revoked", "archived"] as const)("preserves terminal/suspended %s", status => {
    expect(connectionSetupStep({ ...connection, status }, null)).toBe(status);
  });
  it("only calls a connection active after persisted notice and activation evidence", () => {
    expect(connectionSetupStep({ ...connection, status: "active" }, null)).not.toBe("active");
    expect(connectionSetupStep({ ...connection, status: "active", groupRegistered: true, privacyNoticeDelivered: true, activatedAt: "2026-09-23T11:59:00Z" }, { organizerMapped: true })).toBe("active");
  });
  it("orders pairing, group, mapping, permissions, notice", () => {
    expect(connectionSetupStep({ ...connection, status: "pending" }, null)).toBe("pairing");
    expect(connectionSetupStep(connection, null)).toBe("paired");
    const grouped = { ...connection, groupRegistered: true };
    expect(connectionSetupStep(grouped, null)).toBe("group_registered");
    expect(connectionSetupStep(grouped, { organizerMapped: false })).toBe("organizer_mapping_needed");
    expect(connectionSetupStep({ ...grouped, grantedScopes: ["connector.setup"] }, { organizerMapped: true })).toBe("group_registered");
    expect(connectionSetupStep(grouped, { organizerMapped: true })).toBe("ready_for_notice");
  });
  it("requires setup access before activation but not for an already active connection", () => {
    const grouped: AgentConnection = { ...connection, groupRegistered: true, grantedScopes: ["trip.read"] };
    expect(connectionSetupStep(grouped, { organizerMapped: true })).toBe("group_registered");
    expect(connectionSetupStep({ ...grouped, status: "active", activatedAt: "2026-09-23T11:59:00Z", privacyNoticeDelivered: true }, { organizerMapped: true })).toBe("active");
  });
});

describe("setup reducer", () => {
  it.each(["pair", "refresh", "pause", "resume", "rotate", "revoke", "policy", "mapping"] as const)("tracks %s without optimistic activation", operation => {
    const state = setupReducer(initialSetupState, { type: "start", operation, request: 1 });
    expect(state.busy).toBe(operation);
    expect(state.snapshot.connection).toBeNull();
    const done = setupReducer(state, { type: "success", request: 1, snapshot: snapshot(), now });
    expect(done.busy).toBeNull();
    expect(done.snapshot.connection?.status).toBe("paired");
  });
  it("ignores stale responses and clears data on authorization loss", () => {
    const state = setupReducer(initialSetupState, { type: "start", operation: "refresh", request: 2 });
    expect(setupReducer(state, { type: "success", request: 1, snapshot: snapshot(), now })).toBe(state);
    const denied = setupReducer(state, { type: "failure", request: 2, unauthorized: true });
    expect(denied.snapshot.connection).toBeNull();
    expect(denied.error).toMatch(/organizer/i);
  });
  it("expires pairing code and drops it once paired or replaced", () => {
    const pending = { ...connection, status: "pending" as const, pairingExpiresAt: "2026-09-23T12:01:00Z" };
    const state = setupReducer({ ...initialSetupState, request: 1 }, { type: "success", request: 1, snapshot: snapshot(pending), pairingCode: "once-only", now });
    expect(state.pairingCode).toBe("once-only");
    expect(setupReducer(state, { type: "tick", now: now + 60_000 }).pairingCode).toBeNull();
    expect(setupReducer(state, { type: "success", request: 1, snapshot: snapshot(), now }).pairingCode).toBeNull();
    expect(setupReducer(state, { type: "success", request: 1, snapshot: snapshot({ ...pending, lifecycleGeneration: 2 }), now }).pairingCode).toBeNull();
  });
  it("holds rotation credential in memory only and explicitly clears it", () => {
    const state = setupReducer({ ...initialSetupState, request: 1 }, { type: "success", request: 1, snapshot: snapshot(), credential: "replacement", now });
    expect(state.credential).toBe("replacement");
    expect(setupReducer(state, { type: "clear_secrets" }).credential).toBeNull();
    expect(setupReducer(state, { type: "failure", request: 1, unauthorized: true }).credential).toBeNull();
  });
  it.each(["rotate", "revoke"] as const)("discards an earlier bearer when %s begins, including an unknown outcome", operation => {
    const rotated = setupReducer({ ...initialSetupState, request: 1 }, { type: "success", request: 1, snapshot: snapshot(), credential: "earlier-bearer", now });
    const started = setupReducer(rotated, { type: "start", request: 2, operation });
    expect(started.credential).toBeNull();
    const failed = setupReducer(started, { type: "failure", request: 2 });
    expect(failed.credential).toBeNull();
    expect(failed.error).toContain("Refresh");
    const refreshed = setupReducer(failed, { type: "success", request: 2, snapshot: snapshot(), now });
    expect(refreshed.credential).toBeNull();
    expect(setupReducer(failed, { type: "success", request: 1, snapshot: snapshot(), credential: "earlier-bearer", now }).credential).toBeNull();
  });
  it("failed operations retain last known state but report uncertainty, not provider text", () => {
    const state = { ...initialSetupState, request: 1, snapshot: snapshot() };
    const failed = setupReducer(state, { type: "failure", request: 1 });
    expect(failed.snapshot).toBe(state.snapshot);
    expect(failed.error).toMatch(/Refresh/);
  });
});

it("only flags stale active-trip contact and distinguishes failed announcements", () => {
  expect(connectionHealth(snapshot(), now, false)).toEqual([]);
  expect(connectionHealth(snapshot({ ...connection, status: "active", lastSeenAt: "2026-09-23T11:49:00Z" }), now, true)).toContain("no_recent_contact");
  expect(connectionHealth(snapshot({ ...connection, status: "active", lastSeenAt: "2026-09-23T11:59:00Z" }), now, true)).toEqual([]);
});
