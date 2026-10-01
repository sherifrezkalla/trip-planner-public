import { describe, expect, it } from "vitest";
import { createDemoState, demoReducer, type DemoState } from "../fictional-demo";

const openRequest = (): DemoState => demoReducer(demoReducer(createDemoState(), { type: "preview" }), { type: "propose" });
const walkStatus = (state: DemoState) => state.stops.find(stop => stop.id === "walk")?.status;

describe("fictional demo decisions", () => {
  it("does not mutate the plan when previewing, dismissing or opening a request", () => {
    const initial = createDemoState();
    const preview = demoReducer(initial, { type: "preview" });
    expect(preview.proposal).toBe("preview");
    expect(preview.stops).toEqual(initial.stops);
    const dismissed = demoReducer(preview, { type: "discard" });
    expect(dismissed.proposal).toBe("none");
    expect(dismissed.stops).toEqual(initial.stops);
    expect(openRequest().stops).toEqual(initial.stops);
  });
  it("counts one vote per traveler, allows changing it and requires a majority", () => {
    let state = openRequest();
    state = demoReducer(state, { type: "vote", value: 1 });
    state = demoReducer(state, { type: "vote", value: 1 });
    expect(state.votes).toHaveLength(1);
    expect(state.proposal).toBe("open");
    state = demoReducer(state, { type: "vote", value: -1 });
    expect(state.votes).toEqual([{ travelerId: "robin", value: -1 }]);
    state = demoReducer(state, { type: "vote", value: 1 });
    state = demoReducer(state, { type: "traveler", id: "sam" });
    state = demoReducer(state, { type: "vote", value: 1 });
    expect(state.proposal).toBe("applied");
    expect(walkStatus(state)).toBe("removed");
    expect(state.stops.filter(stop => stop.id !== "walk")).toEqual(createDemoState().stops.filter(stop => stop.id !== "walk"));
    expect(demoReducer(state, { type: "vote", value: -1 })).toBe(state);
  });
  it("rejects with a majority against and keeps the itinerary", () => {
    let state = demoReducer(openRequest(), { type: "vote", value: -1 });
    state = demoReducer(state, { type: "traveler", id: "sam" });
    state = demoReducer(state, { type: "vote", value: -1 });
    expect(state.proposal).toBe("rejected");
    expect(walkStatus(state)).toBe("planned");
  });
  it.each(["approve", "reject"] as const)("restricts %s to the sample organizer", type => {
    const open = openRequest();
    expect(demoReducer(open, { type })).toBe(open);
    const organizer = demoReducer(open, { type: "traveler", id: "alex" });
    const decided = demoReducer(organizer, { type });
    expect(decided.proposal).toBe(type === "approve" ? "applied" : "rejected");
    expect(walkStatus(decided)).toBe(type === "approve" ? "removed" : "planned");
  });
  it.each(["preview", "open"] as const)("cancels a %s when its target completes", stage => {
    const state = stage === "open" ? openRequest() : demoReducer(createDemoState(), { type: "preview" });
    const completed = demoReducer(state, { type: "complete", id: "walk" });
    expect(completed.proposal).toBe("cancelled");
    expect(walkStatus(completed)).toBe("done");
    expect(demoReducer(completed, { type: "propose" })).toBe(completed);
    expect(demoReducer(completed, { type: "vote", value: 1 })).toBe(completed);
    expect(demoReducer(completed, { type: "preview" })).toBe(completed);
  });
  it("keeps unrelated completion compatible with a pending request", () => {
    const state = demoReducer(openRequest(), { type: "complete", id: "gallery" });
    expect(state.proposal).toBe("open");
    expect(state.stops.find(stop => stop.id === "gallery")?.status).toBe("done");
  });
  it("does not complete protected, removed, unknown or already-completed stops", () => {
    const initial = createDemoState();
    for (const id of ["breakfast", "dinner", "unknown"]) expect(demoReducer(initial, { type: "complete", id })).toBe(initial);
    const approved = demoReducer(demoReducer(openRequest(), { type: "traveler", id: "alex" }), { type: "approve" });
    expect(demoReducer(approved, { type: "complete", id: "walk" })).toBe(approved);
  });
  it("resets decisions, votes, completion and role with independent fixtures", () => {
    let state = demoReducer(openRequest(), { type: "complete", id: "gallery" });
    state = demoReducer(state, { type: "vote", value: 1 });
    state = demoReducer(state, { type: "traveler", id: "alex" });
    state = demoReducer(state, { type: "approve" });
    const reset = demoReducer(state, { type: "reset" });
    expect(reset).toEqual(createDemoState());
    expect(reset.stops).not.toBe(createDemoState().stops);
  });
});
