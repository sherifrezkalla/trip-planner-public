"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { TRIP_TOKEN_HEADER } from "@/lib/auth";
import type { AuthorityPolicy, TripAgentProvider, TripAgentScope } from "@/lib/trip-agent-contracts";
import { connectionHealth, connectionSetupStep, initialSetupState, mutationSnapshot, providerConfiguration, setupReducer, type AgentConnection, type AgentSnapshot, type SetupOperation, type SetupState } from "@/lib/trip-agent-setup";
import { privacyNotice, TRIP_AGENT_GROUP_PROMPT } from "@/lib/trip-agent-wording";
import AgentParticipantMappings, { type AgentTraveler, type MappingChange } from "./AgentParticipantMappings";
import { agentSetupBrief, CONNECTOR_GUIDE_BASE, installationMcpUrl, ONBOARDING_GUIDANCE, ONBOARDING_STAGES, onboardingStage } from "@/lib/agent-onboarding";

const button = "rounded-full border border-[#EADFCC] px-3 py-1.5 text-sm transition hover:bg-[#F3E0D3] disabled:opacity-50";
const scopes: [TripAgentScope, string][] = [
  ["trip.read", "Read the shared plan (required for activation)"], ["trip.research", "Research trip options"],
  ["trip.propose", "Prepare changes and proposals"], ["trip.modify", "Carry out permitted changes"],
  ["trip.vote", "Record confirmed travelers’ explicit votes"], ["announcement.write", "Record group delivery receipts"],
];
type PolicyChange = AuthorityPolicy & { action: "update_policy"; grantedScopes: TripAgentScope[] };
type Command = { operation: SetupOperation; body?: Record<string, unknown>; mappingId?: string };
type PanelProps = {
  state: SetupState; travelers: AgentTraveler[]; organizer: AgentTraveler; now: number; duringTrip: boolean;
  onCommand: (command: Command) => void; onClearSecrets: () => void;
};

function CopyButton({ text, label, disabled = false }: { text: string; label: string; disabled?: boolean }) {
  const [result, setResult] = useState("");
  return <span className="inline-flex flex-col gap-1">
    <button type="button" className={button} disabled={disabled} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setResult("Copied"); }
      catch { setResult("Could not copy. Select the text and copy it manually."); }
    }}>{label}</button>
    {result && <span role="status" className="text-xs">{result}</span>}
  </span>;
}

function SetupBrief({ provider, disabled }: { provider: TripAgentProvider; disabled: boolean }) {
  let brief: string | null = null;
  try { brief = agentSetupBrief(provider, process.env.NEXT_PUBLIC_SITE_URL); } catch { /* Operator guidance below. */ }
  return <div className="space-y-3 rounded-xl bg-[#F5F0E6] p-4">
    <h3 className="font-semibold">Let your assistant help with setup</h3>
    <p className="text-sm">Copy this brief into a private conversation with your {provider === "hermes" ? "Hermes" : "OpenClaw"} assistant. It explains the setup without sharing your trip, pairing code or credentials.</p>
    {brief ? <>
      <CopyButton text={brief} label="Copy setup brief" disabled={disabled} />
      <details><summary className="cursor-pointer text-sm underline">Read what you’ll share</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{brief}</pre></details>
    </> : <p role="status" className="text-sm">Your app host needs to finish the installation address before a setup brief is available. You can still use the trip without an agent.</p>}
    <p className="text-xs text-[#6F695F]">Your assistant needs permission and the ability to configure its own machine. If it cannot do that, share the brief with the person who runs it. Copying the brief does not connect or activate anything.</p>
  </div>;
}

function SetupProgress({ step, uncertain }: { step: ReturnType<typeof connectionSetupStep>; uncertain: boolean }) {
  const current = onboardingStage(step);
  const guidance = ONBOARDING_GUIDANCE[step];
  return <div className="space-y-3">
    {current !== null && !uncertain && <ol aria-label="Agent setup steps" className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
      {ONBOARDING_STAGES.map((label, index) => <li key={label} aria-current={index === current ? "step" : undefined} className={`rounded-lg border p-2 ${index === current ? "border-[#6F805B] bg-[#EEF1E7] font-semibold" : "border-[#EADFCC]"}`}>
        <span className="mr-1" aria-hidden="true">{index + 1}.</span>{label}
      </li>)}
    </ol>}
    <div aria-live="polite" className="rounded-xl border border-[#EADFCC] p-4">
      <h3 className="font-semibold">{uncertain ? "Refresh to check your connection" : guidance.title}</h3>
      <p className="mt-1 text-sm text-[#6F695F]">{uncertain ? "The last request could not be confirmed. Refresh status before continuing; do not repeat a setup action yet." : guidance.description}</p>
    </div>
  </div>;
}

function AuthorityReview({ connection, disabled, onSave }: { connection: AgentConnection; disabled: boolean; onSave: (policy: PolicyChange) => void }) {
  const [grantedScopes, setScopes] = useState<TripAgentScope[]>(connection.grantedScopes.filter(scope => scope !== "proactive.read"));
  const [policy, setPolicy] = useState(connection.authorityPolicy);
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); onSave({ action: "update_policy", ...policy, grantedScopes: Array.from(new Set(["connector.setup", ...grantedScopes])) }); }}>
    <p className="text-sm">Choose what this connector may do. Trip permissions and organizer approval still apply. Saving access does not activate the connector.</p>
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-2 text-sm font-semibold">Connector access</legend>
      {scopes.map(([scope, label]) => <label key={scope} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={grantedScopes.includes(scope)} onChange={event => setScopes(current => event.target.checked ? [...current, scope] : current.filter(value => value !== scope))} />{label}</label>)}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={policy.travelerCanAddSuggestion} onChange={event => setPolicy(current => ({ ...current, travelerCanAddSuggestion: event.target.checked }))} />Matched travelers may add suggestions</label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={policy.travelerCanProposeChange} onChange={event => setPolicy(current => ({ ...current, travelerCanProposeChange: event.target.checked }))} />Matched travelers may propose changes</label>
      <p className="text-xs text-[#8A8272]">Proactive alerts are a later milestone and are not enabled here.</p>
      <button type="submit" className={button} disabled={!grantedScopes.includes("trip.read")}>Save reviewed access</button>
    </fieldset>
  </form>;
}

function ProviderInstructions({ provider }: { provider: TripAgentProvider }) {
  let configuration: string | null = null;
  try {
    configuration = providerConfiguration(provider, installationMcpUrl(process.env.NEXT_PUBLIC_SITE_URL));
  } catch { /* Display setup guidance instead of copying an invalid endpoint. */ }
  return <details className="rounded-xl border border-[#EADFCC] p-3">
    <summary className="cursor-pointer text-sm font-semibold">Advanced setup help · {provider === "openclaw" ? "OpenClaw" : "Hermes"}</summary>
    <p className="my-2 text-sm">For the person configuring the assistant. Provider support is a preview; full live-trip checks are deferred. Use one explicit WhatsApp group and preserve any existing session. Merge settings carefully rather than replacing shared configuration.</p>
    <a className="text-sm underline" href={`${CONNECTOR_GUIDE_BASE}/${provider}-whatsapp.md`} target="_blank" rel="noreferrer">Open the {provider === "openclaw" ? "OpenClaw" : "Hermes"} connector guide</a>
    {configuration ? <><pre className="my-3 max-h-64 overflow-auto rounded-lg bg-[#F5F0E6] p-3 text-xs">{configuration}</pre>
    <CopyButton text={configuration} label="Copy configuration template" /></> : <p role="status" className="my-3 text-sm">Ask the app operator to set NEXT_PUBLIC_SITE_URL to this installation’s canonical HTTPS address and redeploy before copying a configuration template.</p>}
    <details className="mt-3"><summary className="cursor-pointer text-sm">Group behavior prompt</summary><pre className="my-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{TRIP_AGENT_GROUP_PROMPT}</pre><CopyButton text={TRIP_AGENT_GROUP_PROMPT} label="Copy group prompt" /></details>
  </details>;
}

const operationLabels: Record<string, string> = { register_group: "Register group", readiness: "Check readiness", activate: "Activate", read_context: "Read trip", read_today: "Read today", search_options: "Research options", read_decisions: "Read decisions", preview_change: "Preview change", commit_change: "Commit change", vote: "Record vote", decide: "Organizer decision", report_announcement: "Record announcement", poll_proactive_events: "Check proactive events" };
const statusLabels: Record<string, string> = { received: "Received", previewed: "Preview ready", executing: "In progress", succeeded: "Completed", awaiting_vote: "Awaiting votes", awaiting_confirmation: "Awaiting confirmation", rejected: "Rejected", cancelled: "Cancelled", refused: "Refused", expired: "Expired", failed: "Failed", unknown: "Outcome unknown" };
const authorityLabels: Record<string, string> = { allowed: "Allowed", requires_organizer_confirmation: "Organizer confirmation required", denied: "Denied" };
const deliveryLabels: Record<string, string> = { pending: "Delivery pending", delivered: "Delivered", failed: "Delivery failed", not_required: "No announcement required" };
function dateLabel(value: string | null) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not recorded"; }

export function AgentConnectionPanel({ state, travelers, organizer, now, duringTrip, onCommand, onClearSecrets }: PanelProps) {
  const [selectedProvider, setProvider] = useState<TripAgentProvider | null>(null);
  const [reveal, setReveal] = useState(false);
  const connection = state.snapshot.connection;
  const provider = connection?.status === "pending" && Date.parse(connection.pairingExpiresAt ?? "") > now
    ? connection.provider : selectedProvider ?? connection?.provider ?? "hermes";
  const organizerMapped = state.snapshot.mappings.some(mapping => mapping.status === "confirmed" && travelers.some(traveler => traveler.id === mapping.travelerId && traveler.isOrganizer && traveler.isBot === false));
  const step = connectionSetupStep(connection, { organizerMapped });
  const disabled = !!state.busy || !!state.error;
  const terminal = step === "revoked" || step === "archived";
  const warnings = connectionHealth(state.snapshot, now, duringTrip);
  const expiration = Date.parse(connection?.pairingExpiresAt ?? "");
  const remaining = Math.max(0, Math.ceil((expiration - now) / 1000));
  const secretVisible = state.pairingCode && remaining > 0;
  const canManage = connection && !terminal && connection.status !== "pending";
  const showPolicy = canManage && connection.groupRegistered && organizerMapped;
  const mappingChange = (mappingId: string, change: MappingChange) => onCommand({ operation: "mapping", mappingId, body: change });
  return <section aria-label="Trip agent" className="mb-4 space-y-4 rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-4 text-[#2D2A24] shadow-sm">
    <div className="flex items-center justify-between gap-3"><h2 className="font-display text-xl font-semibold">Trip agent</h2><button type="button" className={button} disabled={!!state.busy} onClick={() => onCommand({ operation: "refresh" })}>{state.busy === "refresh" ? "Refreshing…" : "Refresh status"}</button></div>
    <p className="text-sm text-[#8A8272]">Bring your own assistant to one WhatsApp group. The web app works without one. Guided setup is a preview; your assistant or its operator handles the connection on its machine.</p>
    {state.error && <p role="alert" className="text-sm text-[#B0532F]">{state.error}</p>}
    {!state.loaded ? <p role="status" className="text-sm">Loading connection…</p> : <>
      <SetupProgress step={step} uncertain={!!state.error} />
      {connection && <details className="text-sm"><summary className="cursor-pointer">{state.error ? "Last verified connection details" : "Connection details"}</summary><p className="mt-2">{state.error ? "Last verified status" : "Status"}: <strong>{connection.status}</strong> · {connection.provider === "openclaw" ? "OpenClaw" : "Hermes"}</p><p>Group: {connection.whatsappGroupLabel || "Not registered"} · Bot number: {connection.agentPhoneE164 || "Not recorded"}</p><p>Last contact: {dateLabel(connection.lastSeenAt)}</p></details>}
      {(step === "not_connected" || terminal || step === "pairing") && <div className="space-y-3">
        <label className="block text-sm font-semibold">Your assistant <select className="ml-2 rounded-lg border border-[#EADFCC] p-2" value={provider} disabled={disabled || (step === "pairing" && remaining > 0)} onChange={event => setProvider(event.target.value as TripAgentProvider)}><option value="hermes">Hermes</option><option value="openclaw">OpenClaw</option></select></label>
        {(step === "not_connected" || terminal) && <details className="rounded-xl border border-[#EADFCC] p-3"><summary className="cursor-pointer text-sm">I don’t have an assistant yet</summary><p className="mt-2 text-sm">You can keep planning in the web app. To connect WhatsApp, first ask someone to help you set up Hermes or OpenClaw with a working model account and WhatsApp number. Trip Planner does not provide a hosted agent or create that account for you.</p><a className="mt-2 inline-block text-sm underline" href="https://github.com/sherifrezkalla/trip-planner-public/blob/master/docs/agent-setup.md" target="_blank" rel="noreferrer">Read the getting-started options</a></details>}
        <SetupBrief key={provider} provider={provider} disabled={disabled} />
        {(step === "not_connected" || terminal) && <p className="text-sm">When your assistant says it is ready, generate a code below. Codes expire after ten minutes, so prepare the assistant first.</p>}
        {terminal && <p className="text-sm">This connection is {step}. Its old credential cannot be resumed. Start a new pairing to connect again.</p>}
        {step === "pairing" && <p className="text-sm">{remaining > 0 ? "Waiting for your assistant to connect. A WhatsApp invitation link cannot be used as this code." : "Pairing code expired. Issue a new code when your assistant is ready."}</p>}
        {secretVisible ? <div className="space-y-2"><p className="text-sm">Shown only in this session. Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}.</p><code className="block break-all rounded-lg bg-[#F5F0E6] p-3">{state.pairingCode}</code><CopyButton text={state.pairingCode!} label="Copy pairing code" /></div> : step === "pairing" && remaining > 0 ? <p className="text-sm">The previous code cannot be displayed after a refresh. Issue a replacement if you did not save it.</p> : null}
        <button type="button" className={button} disabled={disabled} onClick={() => { if (step !== "pairing" || window.confirm("Issue a replacement code? The previous pairing code will stop working.")) onCommand({ operation: "pair", body: { provider } }); }}>{step === "pairing" ? "Issue replacement code" : "Issue 10-minute pairing code"}</button>
      </div>}
      {step === "paired" && <p className="text-sm">Ask your assistant to register only the group you chose. This page updates automatically; use Refresh status if needed.</p>}
      {step === "organizer_mapping_needed" && <p className="text-sm font-semibold">Next: confirm which WhatsApp participant is the human organizer.</p>}
      {step === "group_registered" && <p className="text-sm font-semibold">Next: review and save the connector’s access below.</p>}
      {canManage && connection.groupRegistered && <details open={!organizerMapped}><summary className="mb-3 cursor-pointer text-sm font-semibold">Participant matches</summary><AgentParticipantMappings mappings={state.snapshot.mappings} travelers={travelers} disabled={disabled} onChange={mappingChange} /></details>}
      {showPolicy && <details open={step === "group_registered" || step === "ready_for_notice"}><summary className="mb-3 cursor-pointer text-sm font-semibold">What your assistant may do</summary><AuthorityReview key={`${connection.id}:${connection.lifecycleGeneration}:${connection.grantedScopes.join(",")}:${JSON.stringify(connection.authorityPolicy)}`} connection={connection} disabled={disabled} onSave={body => onCommand({ operation: "policy", body })} /></details>}
      {step === "ready_for_notice" && <div className="space-y-3"><p className="text-sm font-semibold">This is what your assistant will share with the group.</p><p className="rounded-xl bg-[#F5F0E6] p-3 text-sm">{privacyNotice(organizer.displayName)}</p><CopyButton text={privacyNotice(organizer.displayName)} label="Copy privacy notice" /><p className="text-sm">Tell your assistant when you approve sending this notice to the selected group. This page will confirm when the connection is active.</p><details><summary className="cursor-pointer text-xs">How delivery is confirmed</summary><p className="mt-2 text-xs">Copying is not delivery. The connector must send this notice, obtain the provider’s actual message receipt, and activate through Trip Planner. Refresh to check confirmation.</p></details></div>}
      {step === "active" && !state.error && <p className="text-sm text-[#5F7A54]">Active: group registration, organizer mapping, access and privacy-notice delivery are confirmed. Proactive alerts require a separately verified workflow.</p>}
      {step === "active" && !state.error && <div className="space-y-2 rounded-xl bg-[#F5F0E6] p-4"><h3 className="text-sm font-semibold">Try it when you’re ready</h3><p className="text-sm">From your personal WhatsApp account, mention your assistant in the selected group and ask:</p><blockquote className="text-sm">What are the dates of our trip?</blockquote><CopyButton text="What are the dates of our trip?" label="Copy a first question" /><p className="text-xs text-[#6F695F]">You can leave this check until your trip. We do not mark conversation tests passed from connection status alone.</p></div>}
      {step === "paused" && <p className="text-sm">Paused. Check the provider and access before resuming. Pending actions are not automatically replayed. Revalidate pending previews and confirmations; expired ones remain expired.</p>}
      {warnings.includes("no_recent_contact") && <p role="status" className="rounded-xl bg-[#F5F0E6] p-3 text-sm">No recent contact observed during the trip. This does not prove the provider is offline. Check the bot’s connection and credentials, then refresh.</p>}
      {warnings.includes("delivery_failed") && <p role="status" className="rounded-xl bg-[#F5F0E6] p-3 text-sm">A group announcement failed. Check the action history and provider delivery. Retry the announcement only after checking its outcome; do not repeat the plan change.</p>}
      {state.credential && <div className="space-y-2 rounded-xl border border-[#B0532F] p-3"><h3 className="text-sm font-semibold">New credential — update the provider now</h3><p className="text-sm">The old credential stopped immediately. Copy this once into the provider’s secret configuration. It is held only in this page’s memory; leaving loses it. If lost, rotate again.</p><input aria-label="New trip agent credential" className="w-full rounded-lg border border-[#EADFCC] p-2 text-sm" type={reveal ? "text" : "password"} readOnly value={state.credential} autoComplete="off" spellCheck={false} /><div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={() => setReveal(value => !value)}>{reveal ? "Hide credential" : "Reveal credential"}</button><CopyButton text={state.credential} label="Copy new credential" /><button type="button" className={button} onClick={() => { setReveal(false); onClearSecrets(); }}>Dismiss credential</button></div></div>}
      {connection && !terminal && <div className="flex flex-wrap gap-2">
        {canManage && <><button type="button" className={button} disabled={disabled} onClick={() => { const operation = step === "paused" ? "resume" : "pause"; if (window.confirm(operation === "pause" ? "Pause this connector’s trip access?" : "Resume this connector’s trip access? Check its provider configuration first. This does not replay actions.")) onCommand({ operation, body: { action: operation } }); }}>{step === "paused" ? "Resume" : "Pause"}</button><button type="button" className={button} disabled={disabled} onClick={() => { if (window.confirm("Rotate the credential? The old credential stops immediately. You must copy the new secret into the provider before it can connect again.")) { setReveal(false); onCommand({ operation: "rotate", body: { action: "rotate" } }); } }}>Rotate credential</button></>}
        <button type="button" className={button} disabled={disabled} onClick={() => { if (window.confirm("Revoke this connection? The old credential stops immediately. Reconnecting requires a new pairing.")) onCommand({ operation: "revoke" }); }}>Revoke connection</button>
      </div>}
      <ProviderInstructions provider={step === "not_connected" || step === "pairing" || terminal ? provider : connection?.provider ?? provider} />
      {!!state.snapshot.recentActions.length && <details><summary className="cursor-pointer text-sm font-semibold">Recent action history</summary><ul className="mt-3 space-y-2">{state.snapshot.recentActions.map(action => <li key={action.id} className="rounded-xl border border-[#EADFCC] p-3 text-sm"><p>{operationLabels[action.operation] ?? "Trip agent action"} · {statusLabels[action.status] ?? "Status unavailable"}</p><p>{travelers.find(traveler => traveler.id === action.mappedTravelerId)?.displayName ?? "Unmatched participant / connector"} · {dateLabel(action.createdAt)}</p><p>{authorityLabels[action.authorityDecision] ?? "Authority unavailable"} · {deliveryLabels[action.announcementStatus] ?? "Delivery unconfirmed"}</p></li>)}</ul></details>}
    </>}
  </section>;
}

function ConnectedSetup({ slug, token, travelers, organizer, duringTrip }: { slug: string; token: string; travelers: AgentTraveler[]; organizer: AgentTraveler; duringTrip: boolean }) {
  const [state, dispatch] = useReducer(setupReducer, initialSetupState);
  const [now, setNow] = useState(0);
  const latest = useRef(state);
  const active = useRef(true);
  const inFlight = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  useEffect(() => { latest.current = state; }, [state]);
  const run = useCallback(async ({ operation, body, mappingId }: Command) => {
    if (inFlight.current || !active.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    const request = ++sequence.current;
    dispatch({ type: "start", operation, request });
    // An unknown mutation outcome requires a fresh read, never an automatic retry.
    const timeout = window.setTimeout(() => {
      controller.abort();
      if (active.current && sequence.current === request) dispatch({ type: "failure", request });
      if (inFlight.current === controller) inFlight.current = null;
    }, 20_000);
    const base = `/api/trips/${encodeURIComponent(slug)}`;
    const endpoint = `${base}/agent-connection`;
    let unauthorized = false;
    try {
      const headers = { [TRIP_TOKEN_HEADER]: token, "Content-Type": "application/json" };
      const response = await fetch(mappingId ? `${base}/agent-participants/${encodeURIComponent(mappingId)}` : endpoint, {
        method: operation === "refresh" ? "GET" : operation === "pair" ? "POST" : operation === "revoke" ? "DELETE" : "PATCH",
        headers, cache: "no-store", signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {}),
      });
      unauthorized = response.status === 401 || response.status === 403;
      if (!response.ok) throw new Error("Request failed");
      const result = await response.json();
      let snapshot: AgentSnapshot;
      if (operation === "mapping") {
        const refresh = await fetch(endpoint, { headers, cache: "no-store", signal: controller.signal });
        unauthorized = refresh.status === 401 || refresh.status === 403;
        if (!refresh.ok) throw new Error("Refresh failed");
        snapshot = await refresh.json();
      } else if (operation === "refresh") snapshot = result;
      else snapshot = mutationSnapshot(latest.current.snapshot, result.connection, operation);
      if (active.current && !controller.signal.aborted && sequence.current === request) {
        const timestamp = Date.now();
        setNow(timestamp);
        dispatch({ type: "success", request, snapshot, now: timestamp, pairingCode: result.pairingCode, credential: result.credential });
      }
    } catch {
      if (active.current && !controller.signal.aborted) dispatch({ type: "failure", request, unauthorized });
    } finally {
      window.clearTimeout(timeout);
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, [slug, token]);
  useEffect(() => {
    active.current = true;
    const initialRefresh = window.setTimeout(() => { void run({ operation: "refresh" }); }, 0);
    const tick = window.setInterval(() => { const timestamp = Date.now(); setNow(timestamp); dispatch({ type: "tick", now: timestamp }); }, 1000);
    const refresh = window.setInterval(() => {
      if (!document.hidden && !latest.current.error && !latest.current.credential) void run({ operation: "refresh" });
    }, 10_000);
    return () => { active.current = false; inFlight.current?.abort(); inFlight.current = null; window.clearTimeout(initialRefresh); window.clearInterval(tick); window.clearInterval(refresh); };
  }, [run]);
  return <AgentConnectionPanel state={state} travelers={travelers} organizer={organizer} now={now} duringTrip={duringTrip} onCommand={command => { void run(command); }} onClearSecrets={() => dispatch({ type: "clear_secrets" })} />;
}

export default function AgentConnectionSetup({ slug, token, travelers, actorId, duringTrip }: { slug: string; token: string; travelers: AgentTraveler[]; actorId: string; duringTrip: boolean }) {
  const organizer = travelers.find(traveler => traveler.id === actorId && traveler.isOrganizer && traveler.isBot === false);
  if (!organizer) return null;
  return <ConnectedSetup key={`${slug}:${token}`} slug={slug} token={token} travelers={travelers} organizer={organizer} duringTrip={duringTrip} />;
}
