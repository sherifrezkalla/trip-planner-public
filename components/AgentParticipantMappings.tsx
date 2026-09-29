"use client";

import { useState } from "react";
import type { AgentMapping } from "@/lib/trip-agent-setup";

export type AgentTraveler = { id: string; displayName: string; isOrganizer: boolean; isBot: boolean };
export type MappingChange = { action: "confirm" | "remap"; travelerId: string } | { action: "revoke" };
const button = "rounded-full border border-[#EADFCC] px-3 py-1.5 text-sm disabled:opacity-50";

function MappingRow({ mapping, travelers, disabled, onChange }: {
  mapping: AgentMapping; travelers: AgentTraveler[]; disabled: boolean;
  onChange: (id: string, change: MappingChange) => void;
}) {
  // A display-name hint never selects or confirms an identity automatically.
  const [travelerId, setTravelerId] = useState(mapping.status === "confirmed" ? mapping.travelerId ?? "" : "");
  const selected = travelers.find(traveler => traveler.id === travelerId);
  return <li className="space-y-2 rounded-xl border border-[#EADFCC] p-3">
    <p className="text-sm">{mapping.displayNameHint || "Unnamed WhatsApp participant"} <span className="text-[#8A8272]">· {mapping.status}</span></p>
    <label className="block text-sm">Match to a person on this trip
      <select value={travelerId} disabled={disabled} onChange={event => setTravelerId(event.target.value)} className="mt-1 block w-full rounded-lg border border-[#EADFCC] bg-white p-2">
        <option value="">Choose a traveler</option>
        {travelers.map(traveler => <option key={traveler.id} value={traveler.id}>{traveler.displayName}{traveler.isOrganizer ? " (organizer)" : ""}</option>)}
      </select>
    </label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={button} disabled={disabled || !selected || (mapping.status === "confirmed" && mapping.travelerId === travelerId)} onClick={() => {
        if (selected && window.confirm(`Confirm that this WhatsApp participant is ${selected.displayName}${selected.isOrganizer ? ", the organizer with organizer authority" : ""}? Verify their identity in the group first.`)) {
          onChange(mapping.id, { action: mapping.status === "confirmed" ? "remap" : "confirm", travelerId });
        }
      }}>{mapping.status === "confirmed" ? "Change match" : "Confirm match"}</button>
      {mapping.status !== "revoked" && <button type="button" className={button} disabled={disabled} onClick={() => {
        if (window.confirm("Remove this participant’s authority? They will be unable to change or vote on the plan.")) onChange(mapping.id, { action: "revoke" });
      }}>Revoke match</button>}
    </div>
  </li>;
}

export default function AgentParticipantMappings({ mappings, travelers, disabled, onChange }: {
  mappings: AgentMapping[]; travelers: AgentTraveler[]; disabled: boolean;
  onChange: (id: string, change: MappingChange) => void;
}) {
  const humans = travelers.filter(traveler => traveler.isBot === false);
  return <div className="space-y-3">
    <p className="text-sm">Confirm the organizer first. Traveler matches are optional. Names are hints only: verify who is speaking in WhatsApp before granting their trip authority.</p>
    {mappings.length === 0 ? <p className="text-sm text-[#8A8272]">No participant hints yet. Ask the connector to check setup readiness using the organizer’s WhatsApp identity, then refresh.</p> :
      <ul className="space-y-2">{mappings.map(mapping => <MappingRow key={`${mapping.id}:${mapping.status}:${mapping.travelerId}`} mapping={mapping} travelers={humans} disabled={disabled} onChange={onChange} />)}</ul>}
  </div>;
}
