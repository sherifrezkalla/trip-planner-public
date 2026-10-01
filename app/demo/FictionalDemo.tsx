"use client";

import Link from "next/link";
import { useReducer } from "react";
import { createDemoState, demoReducer, demoTravelers } from "@/lib/fictional-demo";
import { tallyProposal } from "@/lib/proposals";

const button = "min-h-11 rounded-xl border border-[#BFB09A] px-4 py-2 text-sm font-semibold transition hover:bg-[#F3E0D3] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#A84A15] disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${button} border-[#A84A15] bg-[#A84A15] text-white hover:bg-[#853B12]`;

export default function FictionalDemo() {
  const [state, dispatch] = useReducer(demoReducer, undefined, createDemoState);
  const active = state.stops.filter(stop => stop.status !== "removed");
  const completed = active.filter(stop => stop.status === "done").length;
  const next = active.find(stop => stop.status === "planned");
  const walk = state.stops.find(stop => stop.id === "walk")!;
  const tally = tallyProposal({ votes: state.votes, travelerCount: demoTravelers.length });
  const currentTraveler = demoTravelers.find(person => person.id === state.traveler)!;
  const ownVote = state.votes.find(vote => vote.travelerId === state.traveler)?.value;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-10">
      <nav aria-label="Demo navigation" className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <Link href="/" prefetch={false} className="font-display text-xl font-semibold underline decoration-[#C2571B] underline-offset-4">Trip Planner</Link>
        <button className={button} onClick={() => dispatch({ type: "reset" })}>Reset demo</button>
      </nav>
      <header className="mb-8 max-w-3xl">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[#A84A15]">Fictional demo · no setup needed</p>
        <h1 className="font-display text-4xl leading-tight sm:text-5xl">One day in Lisbon.<br />A plan you can change together.</h1>
        <p className="mt-4 text-lg text-[#62594B]">Meet Alex, Sam and Robin. Explore their sample day, preview a change, and see a group decision update the plan.</p>
        <p className="mt-3 text-sm text-[#62594B]">All people, stops, times and reservations below are made up. Changes stay in this page and disappear on reset or reload.</p>
      </header>

      <div className="mb-6 rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-5">
        <h2 className="mb-3 font-semibold" id="traveler-label">1. Try a traveler’s role</h2>
        <div role="group" aria-labelledby="traveler-label" className="grid gap-3 sm:grid-cols-3">
          {demoTravelers.map(person => (
            <button key={person.id} aria-pressed={state.traveler === person.id} onClick={() => dispatch({ type: "traveler", id: person.id })} className={`${button} text-left ${state.traveler === person.id ? "border-[#A84A15] bg-[#F3E0D3]" : "bg-white"}`}>
              <span className="block text-base">{person.name}</span>
              <span className="block font-normal text-[#62594B]">{person.detail}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-sm text-[#62594B]">Role switching is just for this demo. Real trips keep each traveler’s identity separate.</p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[1.15fr_1fr]">
        <section aria-labelledby="plan-title" className="rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="plan-title" className="font-display text-2xl">Your sample Saturday</h2>
            <span className="text-sm">{completed} of {active.length} stops done</span>
          </div>
          <p className="mt-2 text-sm text-[#62594B]">Next planned stop: <strong className="text-[#2D2A24]">{next?.title ?? "Day complete"}</strong></p>
          <ol className="mt-5 space-y-4">
            {state.stops.map(stop => (
              <li key={stop.id} className={`rounded-xl border p-4 ${stop.status === "removed" ? "border-dashed border-[#BFB09A]" : "border-[#EADFCC] bg-white"}`}>
                <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-[#62594B]">
                  <span>{stop.time}</span>
                  <span>{stop.status === "removed" ? "Removed · free time" : stop.status === "done" ? "Done" : stop.protected ? "Protected · example booking" : "Planned"}</span>
                </div>
                <h3 className={`font-semibold ${stop.status === "removed" ? "line-through" : ""}`}>{stop.title}</h3>
                <p className="mt-1 text-sm text-[#62594B]">{stop.status === "removed" ? "Leave the afternoon open and decide later." : stop.description}</p>
                {stop.status === "planned" && !stop.protected && (
                  <button className={`${button} mt-3`} aria-label={`Mark ${stop.title.toLowerCase()} done`} onClick={() => dispatch({ type: "complete", id: stop.id })}>Mark done</button>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="change-title" className="rounded-2xl border border-[#EADFCC] bg-[#FFFDF8] p-5 sm:p-6">
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[#A84A15]">A change of plans</p>
          <h2 id="change-title" className="font-display text-2xl">2. What if it rains?</h2>
          <p className="mt-3 text-[#62594B]">Imagine rain in the afternoon. Try removing the riverside walk so the group has free time, while keeping the dinner reservation.</p>
          <p className="mt-2 text-sm text-[#62594B]">This is a scripted example, not a live weather forecast or AI answer.</p>
          {["none", "rejected", "cancelled"].includes(state.proposal) && (
            <button className={`${primary} mt-5`} disabled={walk.status !== "planned"} onClick={() => dispatch({ type: "preview" })}>Preview afternoon change</button>
          )}
          {state.proposal === "preview" && (
            <div className="mt-5 rounded-xl bg-[#F3E0D3] p-4">
              <h3 className="font-semibold">Review before asking the group</h3>
              <ul className="mt-3 space-y-2 text-sm">
                <li>Change: 15:00 riverside walk → free afternoon.</li>
                <li>Keep: completed breakfast, gallery visit and 19:00 dinner.</li>
                <li>Trade-off: less outdoor exploring, more flexibility.</li>
                <li>No booking is changed or cancelled.</li>
              </ul>
              <div className="mt-4 flex flex-wrap gap-3">
                <button className={primary} onClick={() => dispatch({ type: "propose" })}>Ask the sample group</button>
                <button className={button} onClick={() => dispatch({ type: "discard" })}>Keep the original plan</button>
              </div>
            </div>
          )}
          {state.proposal === "open" && (
            <div className="mt-5 rounded-xl border border-[#BFB09A] p-4">
              <h3 className="font-semibold">3. Decide together</h3>
              <p className="mt-2 text-sm">Remove the 15:00 walk? Two of three travelers must agree, or Alex can approve as organizer.</p>
              <p className="mt-3 text-sm">Voting as <strong>{currentTraveler.name}</strong></p>
              <p className="mt-3 font-semibold">{tally.yes} agree · {tally.no} against · {tally.needed} needed</p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button className={button} aria-pressed={ownVote === 1} onClick={() => dispatch({ type: "vote", value: 1 })}>Agree</button>
                <button className={button} aria-pressed={ownVote === -1} onClick={() => dispatch({ type: "vote", value: -1 })}>Vote against</button>
              </div>
              <p className="mt-3 text-sm text-[#62594B]">Switch traveler above to try another vote. Repeating a vote does not count twice.</p>
              {state.traveler === "alex" && (
                <div className="mt-4 flex flex-wrap gap-3 border-t border-[#EADFCC] pt-4">
                  <button className={primary} onClick={() => dispatch({ type: "approve" })}>Approve as organizer</button>
                  <button className={button} onClick={() => dispatch({ type: "reject" })}>Turn down</button>
                </div>
              )}
            </div>
          )}
          <p role="status" aria-live="polite" aria-atomic="true" className="mt-5 rounded-xl bg-[#F1EBDD] p-4 text-sm leading-relaxed">{state.message}</p>
          {["applied", "rejected", "cancelled"].includes(state.proposal) ? (
            <div className="mt-4">
              <p className="mb-3 text-sm text-[#62594B]">Reset to try another decision path, or continue marking planned stops done.</p>
              <button className={button} onClick={() => dispatch({ type: "reset" })}>Start this example again</button>
            </div>
          ) : (
            <p className="mt-4 text-sm text-[#62594B]">Try marking the walk done while a request is open: the outdated request cancels instead of changing a completed stop.</p>
          )}
        </section>
      </div>

      <footer className="mt-8 rounded-2xl bg-[#2D2A24] p-6 text-[#FFFDF8] sm:p-8">
        <h2 className="font-display text-2xl">The shared plan is the starting point.</h2>
        <p className="mt-3 max-w-3xl text-[#EADFCC]">A configured Trip Planner installation adds real invitations, venue-based AI planning and saved group decisions. An optional Hermes or OpenClaw assistant can use the trip gateway; full WhatsApp behavior is still in preview. This demo does not connect an agent, contact anyone or make bookings.</p>
        <div className="mt-5 flex flex-wrap gap-5 text-sm font-semibold">
          <a className="underline underline-offset-4" href="https://github.com/sherifrezkalla/trip-planner-public#readme">Explore the open-source project</a>
          <a className="underline underline-offset-4" href="https://github.com/sherifrezkalla/trip-planner-public/blob/master/docs/project-tour.md">Read the full walkthrough</a>
        </div>
      </footer>
    </main>
  );
}
