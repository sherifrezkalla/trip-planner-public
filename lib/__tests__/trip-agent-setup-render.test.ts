import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentConnectionSetup, { AgentConnectionPanel } from "@/components/AgentConnectionSetup";
import AgentParticipantMappings from "@/components/AgentParticipantMappings";
import { initialSetupState, mutationSnapshot, setupReducer, type AgentConnection, type SetupState } from "../trip-agent-setup";

// Capture rendered host handlers while keeping React's real server renderer and
// hooks. This exercises click/submit contracts without a second DOM dependency.
const rendered = vi.hoisted(() => ({ elements: [] as ReactElement<Record<string, unknown>>[] }));
vi.mock("react/jsx-runtime", async importOriginal => {
  const actual = await importOriginal<Record<string, (...args: unknown[]) => ReactElement<Record<string, unknown>>>>();
  const capture = (name: "jsx" | "jsxs") => (...args: unknown[]) => {
    const element = actual[name](...args);
    if (typeof element.type === "string") rendered.elements.push(element);
    return element;
  };
  return { ...actual, jsx: capture("jsx"), jsxs: capture("jsxs") };
});
vi.mock("react/jsx-dev-runtime", async importOriginal => {
  const actual = await importOriginal<Record<string, (...args: unknown[]) => ReactElement<Record<string, unknown>>>>();
  return { ...actual, jsxDEV: (...args: unknown[]) => {
    const element = actual.jsxDEV(...args);
    if (typeof element.type === "string") rendered.elements.push(element);
    return element;
  } };
});

const now = Date.parse("2026-09-23T12:00:00Z");
const organizer = { id: "human", displayName: "Alex", isOrganizer: true, isBot: false };
const traveler = { id: "traveler", displayName: "Guest", isOrganizer: false, isBot: false };
const bot = { id: "bot", displayName: "Private bot", isOrganizer: true, isBot: true };
const travelers = [organizer, traveler, bot];
const connection: AgentConnection = {
  id: "connection", provider: "openclaw", status: "paired", lifecycleGeneration: 1,
  pairingExpiresAt: null, grantedScopes: ["connector.setup", "trip.read"],
  authorityPolicy: { travelerCanAddSuggestion: true, travelerCanProposeChange: true },
  agentPhoneE164: null, whatsappGroupLabel: "Family trip", groupRegistered: true,
  privacyNoticeDelivered: false, lastSeenAt: null, pairedAt: "2026-09-23T11:59:00Z",
  activatedAt: null, pausedAt: null, revokedAt: null, archivedAt: null,
  createdAt: "2026-09-23T11:58:00Z", updatedAt: "2026-09-23T11:59:00Z",
};
const mapping = { id: "mapping", displayNameHint: "Alex on WhatsApp", travelerId: organizer.id, status: "confirmed" as const };
const onCommand = vi.fn();
const onClearSecrets = vi.fn();
function state(patch: Partial<AgentConnection> = {}, extras: Partial<SetupState> = {}): SetupState {
  return { ...initialSetupState, loaded: true, snapshot: { connection: { ...connection, ...patch }, mappings: [mapping], recentActions: [] }, ...extras };
}
function panel(value = state()) {
  rendered.elements.length = 0;
  return renderToStaticMarkup(createElement(AgentConnectionPanel, { state: value, travelers, organizer, now, duringTrip: true, onCommand, onClearSecrets }));
}
function content(value: unknown): string {
  if (Array.isArray(value)) return value.map(content).join("");
  if (value && typeof value === "object" && "props" in value) return content((value as ReactElement<{ children: ReactNode }>).props.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function button(label: string) {
  const element = rendered.elements.find(element => element.type === "button" && content(element.props.children) === label);
  expect(element, `Missing button: ${label}`).toBeDefined();
  return element!;
}
function click(label: string) { (button(label).props.onClick as () => void)(); }

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => vi.unstubAllGlobals());

describe("organizer-only setup rendering", () => {
  it.each(["traveler", "bot", "missing"])("does not expose setup to %s", actorId => {
    expect(renderToStaticMarkup(createElement(AgentConnectionSetup, { slug: "trip", token: "private", actorId, travelers, duringTrip: false }))).toBe("");
  });
  it("requires explicit human status and renders loading for a human organizer", () => {
    expect(renderToStaticMarkup(createElement(AgentConnectionSetup, { slug: "trip", token: "private", actorId: "human", travelers, duringTrip: false }))).toContain("Loading connection");
    expect(renderToStaticMarkup(createElement(AgentConnectionSetup, { slug: "trip", token: "private", actorId: "human", travelers: [{ ...organizer, isBot: undefined as unknown as boolean }], duringTrip: false }))).toBe("");
  });
  it.each(["openclaw", "hermes"] as const)("links to the existing %s guide and keeps secrets outside templates", provider => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://planner.example.com");
    const html = panel(state({ provider }, { credential: "live-rotation-secret" }));
    vi.unstubAllEnvs();
    expect(html).toContain(`/docs/connectors/${provider}-whatsapp.md`);
    const templates = rendered.elements.filter(element => element.type === "pre").map(element => content(element.props.children)).join("\n");
    expect(templates).toContain("Bearer <TRIP_AGENT_CREDENTIAL>");
    expect(templates).not.toContain("live-rotation-secret");
    expect(html).toContain('type="password"');
    click("Dismiss credential");
    expect(onClearSecrets).toHaveBeenCalledOnce();
  });
  it("requires persisted activation and notice evidence", () => {
    expect(panel(state())).toContain("Copying is not delivery");
    expect(panel(state({ status: "active", privacyNoticeDelivered: false }))).not.toContain("Active: group registration");
    expect(panel(state({ status: "active", privacyNoticeDelivered: true, activatedAt: "2026-09-23T11:59:00Z" }))).toContain("Active: group registration");
    expect(onCommand).not.toHaveBeenCalled();
  });
  it("shows mapping and access as separate prerequisites", () => {
    const unmapped = state();
    unmapped.snapshot.mappings = [];
    expect(panel(unmapped)).toContain("confirm which WhatsApp participant is the human organizer");
    expect(panel(state({ grantedScopes: ["connector.setup"] }))).toContain("review and save the connector");
    expect(button("Save reviewed access").props.disabled).toBe(true);
  });
  it("shows countdown only for an unexpired session code and keeps the pending provider", () => {
    const pending = state({ status: "pending", provider: "hermes", pairingExpiresAt: new Date(now + 61000).toISOString() }, { pairingCode: "once-only-code" });
    expect(panel(pending)).toContain("Expires in 1:01");
    expect(panel(pending)).toContain("once-only-code");
    click("Issue replacement code");
    expect(onCommand).toHaveBeenCalledWith({ operation: "pair", body: { provider: "hermes" } });
    expect(panel({ ...pending, pairingCode: null })).toContain("previous code cannot be displayed");
    expect(panel(state({ status: "pending", pairingExpiresAt: new Date(now - 1).toISOString() }, { pairingCode: "expired-secret" }))).not.toContain("expired-secret");
  });
  it("shows cautious offline/delivery guidance and redacted action history", () => {
    const active = state({ status: "active", privacyNoticeDelivered: true, activatedAt: "2026-09-23T11:59:00Z" });
    active.snapshot.recentActions = [{ id: "action", mappedTravelerId: organizer.id, operation: "commit_change", status: "succeeded", authorityDecision: "allowed", announcementStatus: "failed", createdAt: "2026-09-23T11:59:00Z", ...{ request: "private request body", result: "private result body" } }];
    const html = panel(active);
    expect(html).toContain("does not prove the provider is offline");
    expect(html).toContain("do not repeat the plan change");
    expect(html).toContain("Commit change");
    expect(html).toContain("Completed");
    expect(html).toContain("Alex");
    expect(html).not.toContain("private request body");
    expect(html).not.toContain("private result body");
  });
  it("disables uncertain actions and removes all connection data after authorization loss", () => {
    const stale = state({ status: "active", privacyNoticeDelivered: true, activatedAt: "2026-09-23T11:59:00Z" }, { error: "Refresh before trying again" });
    const html = panel(stale);
    expect(html).toContain("Last verified status");
    expect(html).not.toContain("Active: group registration");
    expect(button("Rotate credential").props.disabled).toBe(true);
    expect(button("Refresh status").props.disabled).toBe(false);
    const denied = setupReducer({ ...stale, pairingCode: "private-code", credential: "private-credential" }, { type: "failure", request: stale.request, unauthorized: true });
    const deniedHtml = panel(denied);
    for (const sensitive of ["Family trip", "private-code", "private-credential", "Alex on WhatsApp"]) expect(deniedHtml).not.toContain(sensitive);
    expect(button("Issue 10-minute pairing code").props.disabled).toBe(true);
  });
  it.each(["revoked", "archived"] as const)("requires new pairing for %s connections", status => {
    expect(panel(state({ status }))).toContain("Start a new pairing");
    expect(rendered.elements.some(element => element.type === "button" && content(element.props.children) === "Resume")).toBe(false);
  });
});

describe("mutation snapshot lifecycle boundaries", () => {
  function cachedState() {
    const cached = state();
    cached.snapshot.recentActions = [{ id: "old-action", mappedTravelerId: organizer.id, operation: "commit_change", status: "succeeded", authorityDecision: "allowed", announcementStatus: "delivered", createdAt: connection.createdAt }];
    return cached;
  }
  it.each([
    { id: "replacement-connection" }, { lifecycleGeneration: 2 },
  ])("does not inherit organizer readiness or history after replacement %j", replacement => {
    const cached = cachedState();
    const next = setupReducer(cached, { type: "success", request: 0, now, snapshot: mutationSnapshot(cached.snapshot, { ...connection, ...replacement }, "policy") });
    expect(next.snapshot.mappings).toEqual([]);
    expect(next.snapshot.recentActions).toEqual([]);
    const html = panel(next);
    expect(html).toContain("confirm which WhatsApp participant is the human organizer");
    expect(html).not.toContain("Alex on WhatsApp");
    expect(html).not.toContain("Recent action history");
    expect(html).not.toContain("Next: have the connector deliver the privacy notice");
  });
  it("retains current-generation organizer readiness and history", () => {
    const cached = cachedState();
    const next = setupReducer(cached, { type: "success", request: 0, now, snapshot: mutationSnapshot(cached.snapshot, { ...connection, updatedAt: new Date(now).toISOString() }, "policy") });
    expect(next.snapshot.mappings).toBe(cached.snapshot.mappings);
    expect(next.snapshot.recentActions).toBe(cached.snapshot.recentActions);
    const html = panel(next);
    expect(html).toContain("Introduce the assistant to your group");
    expect(html).toContain("Recent action history");
  });
  it("clears collections on pairing even if the response has the same identity", () => {
    const cached = cachedState();
    expect(mutationSnapshot(cached.snapshot, connection, "pair")).toEqual({ connection, mappings: [], recentActions: [] });
    expect(mutationSnapshot(cached.snapshot, null, "revoke")).toEqual({ connection: null, mappings: [], recentActions: [] });
  });
  it("keeps the once-returned rotation secret while clearing stale collections, and cannot recover it after dismissal", () => {
    const cached = cachedState();
    const started = setupReducer(cached, { type: "start", request: 1, operation: "rotate" });
    const snapshot = mutationSnapshot(cached.snapshot, { ...connection, lifecycleGeneration: 2 }, "rotate");
    const rotated = setupReducer(started, { type: "success", request: 1, now, snapshot, credential: "once-returned-credential" });
    expect(rotated.snapshot.mappings).toEqual([]);
    expect(rotated.snapshot.recentActions).toEqual([]);
    expect(panel(rotated)).toContain('value="once-returned-credential"');
    const dismissed = setupReducer(rotated, { type: "clear_secrets" });
    const refreshed = setupReducer(dismissed, { type: "success", request: 1, now, snapshot });
    expect(refreshed.credential).toBeNull();
    expect(panel(refreshed)).not.toContain("once-returned-credential");
    expect(setupReducer(initialSetupState, { type: "success", request: 0, now, snapshot }).credential).toBeNull();
  });
});

describe("setup command interactions", () => {
  it.each([
    ["Pause", "pause", "paired"], ["Resume", "resume", "paused"], ["Rotate credential", "rotate", "paired"], ["Revoke connection", "revoke", "paired"],
  ] as const)("confirms %s and emits only the documented command", (label, operation, status) => {
    panel(state({ status }));
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    click(label);
    expect(onCommand).not.toHaveBeenCalled();
    click(label);
    expect(window.confirm).toHaveBeenCalledTimes(2);
    expect(onCommand).toHaveBeenCalledWith(operation === "revoke" ? { operation } : { operation, body: { action: operation } });
    if (operation === "rotate" || operation === "revoke") expect(vi.mocked(window.confirm).mock.calls[0][0]).toContain("old credential stops immediately");
  });
  it("submits authority policy with mandatory setup scope and no proactive access", () => {
    panel(state({ grantedScopes: ["connector.setup", "trip.read", "trip.modify", "proactive.read"] }));
    const form = rendered.elements.find(element => element.type === "form")!;
    const preventDefault = vi.fn();
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onCommand).toHaveBeenCalledWith({ operation: "policy", body: { action: "update_policy", travelerCanAddSuggestion: true, travelerCanProposeChange: true, grantedScopes: ["connector.setup", "trip.read", "trip.modify"] } });
  });
  it("does not turn a matching display-name hint into a confirmed traveler", () => {
    rendered.elements.length = 0;
    const html = renderToStaticMarkup(createElement(AgentParticipantMappings, { travelers, mappings: [{ ...mapping, status: "suggested" }], disabled: false, onChange: vi.fn() }));
    expect(html).not.toContain("Private bot");
    expect(html).toContain('<option value="" selected="">Choose a traveler</option>');
    expect(button("Confirm match").props.disabled).toBe(true);
  });
  it("requires confirmation to revoke a participant and sends the mapping ID", () => {
    panel(state());
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    click("Revoke match");
    expect(onCommand).not.toHaveBeenCalled();
    click("Revoke match");
    expect(onCommand).toHaveBeenCalledWith({ operation: "mapping", mappingId: "mapping", body: { action: "revoke" } });
  });
});


describe("provider template deployment address", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([undefined, "", "not-an-origin", "https://planner.example.com/path"])("does not offer a template for invalid configuration %s", site => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", site);
    const html = panel(state());
    expect(html).toContain("canonical HTTPS address");
    expect(html).not.toContain("Copy configuration template");
  });
  it("uses the configured installation for the copied template", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://planner.example.com/");
    const html = panel(state({ provider: "hermes" }));
    expect(html).toContain("https://planner.example.com/api/mcp");
    expect(html).toContain("Copy configuration template");
  });
});

describe("guided agent onboarding", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("starts with an assistant handoff and an honest path for people without an agent", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://planner.example");
    const html = panel({ ...initialSetupState, loaded: true });
    expect(html).toContain('aria-label="Agent setup steps"');
    expect(html).toContain("Bring the assistant you already use");
    expect(html).toContain("I don’t have an assistant yet");
    expect(html).toContain("does not provide a hosted agent");
    expect(html).toContain("Copy setup brief");
    const advanced = rendered.elements.find(el => el.type === "details" && content(el.props.children).includes("Copy configuration template"));
    expect(advanced?.props.open).toBeUndefined();
    expect(onCommand).not.toHaveBeenCalled();
  });
  it("copies only the setup brief, never the pairing code, and does not pair automatically", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://planner.example");
    panel(state({ provider: "hermes", status: "pending", pairingExpiresAt: new Date(now + 60000).toISOString() }, { pairingCode: "private-once-code" }));
    await (button("Copy setup brief").props.onClick as () => Promise<void>)();
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(copied).toContain("existing Hermes assistant");
    expect(copied).not.toContain("private-once-code");
    expect(copied).not.toContain("Family trip");
    expect(onCommand).not.toHaveBeenCalled();
    const providerSelect = rendered.elements.find(el => el.type === "select" && el.props.value === "hermes");
    expect(providerSelect?.props.disabled).toBe(true);
  });
  it.each([undefined, "https://planner.example/t/private?token=secret"])("does not offer a setup brief without a safe configured origin", site => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", site);
    expect(panel({ ...initialSetupState, loaded: true })).not.toContain("Copy setup brief");
  });
  it("reflects server prerequisites rather than marking completion after copying", () => {
    expect(panel(state({ groupRegistered: false }))).toContain("Choose your WhatsApp group");
    const unmapped = state(); unmapped.snapshot.mappings = [];
    expect(panel(unmapped)).toContain("Confirm your personal WhatsApp identity");
    expect(panel(state())).toContain("Introduce the assistant to your group");
    expect(panel(state())).not.toContain("Your assistant is connected");
    expect(panel(state({ status: "active", activatedAt: "2026-09-23T11:59:00Z", privacyNoticeDelivered: true }))).toContain("You can leave this check until your trip");
    expect(panel(state({ status: "paused" }))).toContain("trip access is paused");
  });
  it("removes apparent progress on an uncertain request and disables the handoff", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://planner.example");
    const html = panel(state({ status: "pending" }, { error: "Refresh before retrying" }));
    expect(html).toContain("Refresh to check your connection");
    expect(html).not.toContain('aria-current="step"');
    expect(button("Copy setup brief").props.disabled).toBe(true);
  });
});
