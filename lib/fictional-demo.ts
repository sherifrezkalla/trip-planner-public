import { tallyProposal, type ProposalVote } from "./proposals";

export const demoTravelers = [
  { id: "alex", name: "Alex", detail: "Organizer · relaxed pace" },
  { id: "sam", name: "Sam", detail: "Food & markets" },
  { id: "robin", name: "Robin", detail: "Art & history" },
] as const;
export type DemoTraveler = (typeof demoTravelers)[number]["id"];
export type DemoStop = {
  id: string;
  time: string;
  title: string;
  description: string;
  status: "planned" | "done" | "removed";
  protected: boolean;
};
export type DemoState = {
  traveler: DemoTraveler;
  stops: DemoStop[];
  proposal: "none" | "preview" | "open" | "applied" | "rejected" | "cancelled";
  votes: ProposalVote[];
  message: string;
};
export type DemoAction =
  | { type: "reset" }
  | { type: "traveler"; id: DemoTraveler }
  | { type: "preview" | "discard" | "propose" | "approve" | "reject" }
  | { type: "vote"; value: 1 | -1 }
  | { type: "complete"; id: string };

export function createDemoState(): DemoState {
  return {
    traveler: "robin",
    proposal: "none",
    votes: [],
    message: "Try a change to the afternoon, or mark the gallery visit done.",
    stops: [
      { id: "breakfast", time: "09:00", title: "Neighborhood breakfast", description: "A slow start and pastries for the group.", status: "done", protected: true },
      { id: "gallery", time: "11:00", title: "Small gallery visit", description: "An indoor stop for Robin’s interest in art.", status: "planned", protected: false },
      { id: "walk", time: "15:00", title: "Riverside walk", description: "An outdoor afternoon with time to explore.", status: "planned", protected: false },
      { id: "dinner", time: "19:00", title: "Dinner together", description: "Example reservation · keep this time protected.", status: "planned", protected: true },
    ],
  };
}

function settle(state: DemoState, apply: boolean, message: string): DemoState {
  return {
    ...state,
    proposal: apply ? "applied" : "rejected",
    stops: apply ? state.stops.map(stop => stop.id === "walk" ? { ...stop, status: "removed" } : stop) : state.stops,
    message,
  };
}

// A disposable teaching model. Production authorization and persistence stay in the API.
export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  if (action.type === "reset") return createDemoState();
  if (action.type === "traveler") return { ...state, traveler: action.id };
  if (action.type === "complete") {
    const target = state.stops.find(stop => stop.id === action.id);
    if (!target || target.protected || target.status !== "planned") return state;
    const stale = target.id === "walk" && ["preview", "open"].includes(state.proposal);
    return {
      ...state,
      stops: state.stops.map(stop => stop.id === target.id ? { ...stop, status: "done" } : stop),
      proposal: stale ? "cancelled" : state.proposal,
      message: stale ? "Walk marked done. The old change is cancelled because that stop is now complete." : `${target.title} marked done. The next planned stop moves forward.`,
    };
  }
  const walk = state.stops.find(stop => stop.id === "walk");
  if (action.type === "preview" && walk?.status === "planned" && state.proposal !== "open") {
    return { ...state, proposal: "preview", votes: [], message: "Preview only. Your sample plan has not changed." };
  }
  if (action.type === "discard" && state.proposal === "preview") {
    return { ...state, proposal: "none", message: "Preview dismissed. The walk stays in the plan." };
  }
  if (action.type === "propose" && state.proposal === "preview" && walk?.status === "planned") {
    return { ...state, proposal: "open", votes: [], message: "Sample request opened. Try voting as two travelers, or approve as Alex." };
  }
  if (state.proposal !== "open" || walk?.status !== "planned") return state;
  if (action.type === "approve" && state.traveler === "alex") return settle(state, true, "Alex approved the request. The afternoon is now free; breakfast and dinner stay unchanged.");
  if (action.type === "reject" && state.traveler === "alex") return settle(state, false, "Alex turned down the request. The walk stays in the plan.");
  if (action.type === "vote") {
    const votes = [...state.votes.filter(vote => vote.travelerId !== state.traveler), { travelerId: state.traveler, value: action.value }];
    const tally = tallyProposal({ votes, travelerCount: demoTravelers.length });
    const voted = { ...state, votes };
    if (tally.outcome === "apply") return settle(voted, true, "Two of three travelers agreed. The afternoon is now free; breakfast and dinner stay unchanged.");
    if (tally.outcome === "reject") return settle(voted, false, "Two of three travelers voted against. The walk stays in the plan.");
    return { ...voted, message: "Vote recorded. One traveler has one vote; switch traveler to try the group decision." };
  }
  return state;
}
