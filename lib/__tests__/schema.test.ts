import { describe, it, expect } from "vitest";
import {
  itineraryPlanSchema,
  swapBlockSchema,
  createTripSchema,
  createSuggestionSchema,
  conciergeChatSchema,
  joinTripSchema,
  reshuffleRequestSchema,
  updateReservationSchema,
} from "@/lib/schema";

const validPlan = {
  days: [
    {
      dayIndex: 0,
      area: "Lisbon",
      blocks: [
        { block: "morning", candidateId: "abc", whyNote: "for the history fans", durationMin: 120 },
        { block: "lunch", candidateId: "def", whyNote: "vegetarian friendly", durationMin: 60 },
        { block: "afternoon", candidateId: "ghi", whyNote: "for the art fans", durationMin: 120 },
        { block: "dinner", candidateId: "jkl", whyNote: "works for everyone", durationMin: 90 },
      ],
    },
  ],
};

describe("itineraryPlanSchema", () => {
  it("accepts a valid plan", () => {
    expect(itineraryPlanSchema.safeParse(validPlan).success).toBe(true);
  });
  it("rejects an unknown block name", () => {
    const bad = structuredClone(validPlan);
    (bad.days[0].blocks[0] as { block: string }).block = "brunch";
    expect(itineraryPlanSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects a missing candidateId", () => {
    const bad = structuredClone(validPlan);
    (bad.days[0].blocks[0] as { candidateId?: string }).candidateId = "";
    expect(itineraryPlanSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects a missing day area", () => {
    const bad = structuredClone(validPlan) as { days: { area?: string }[] };
    delete bad.days[0].area;
    expect(itineraryPlanSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects an implausibly long visit", () => {
    const bad = structuredClone(validPlan);
    bad.days[0].blocks[0].durationMin = 24 * 60;
    expect(itineraryPlanSchema.safeParse(bad).success).toBe(false);
  });
  it("accepts a light day of just lunch and dinner", () => {
    const light = structuredClone(validPlan);
    light.days[0].blocks = light.days[0].blocks.filter(
      (block) => block.block === "lunch" || block.block === "dinner",
    );
    expect(itineraryPlanSchema.safeParse(light).success).toBe(true);
  });
  it("accepts a day that is dinner and nothing else", () => {
    const dinnerOnly = structuredClone(validPlan);
    dinnerOnly.days[0].blocks = dinnerOnly.days[0].blocks.filter((b) => b.block === "dinner");
    expect(itineraryPlanSchema.safeParse(dinnerOnly).success).toBe(true);
  });
  it("rejects a day with nothing in it at all", () => {
    const empty = structuredClone(validPlan);
    empty.days[0].blocks = [];
    expect(itineraryPlanSchema.safeParse(empty).success).toBe(false);
  });
});

describe("swapBlockSchema", () => {
  it("accepts a valid swap block", () => {
    expect(swapBlockSchema.safeParse({ candidateId: "x", whyNote: "y", durationMin: 90 }).success).toBe(true);
  });
});

describe("createTripSchema", () => {
  const base = {
    destinationName: "Lisbon",
    destinationPlaceId: "ChIJ123",
    lat: 38.72,
    lng: -9.14,
    startDate: "2026-09-10",
    endDate: "2026-09-13",
    budgetLevel: "mid",
  };
  it("accepts a valid trip", () => {
    expect(createTripSchema.safeParse(base).success).toBe(true);
  });
  it("rejects endDate before startDate", () => {
    expect(createTripSchema.safeParse({ ...base, endDate: "2026-09-01" }).success).toBe(false);
  });
});

describe("joinTripSchema", () => {
  it("accepts a valid traveler", () => {
    const t = { displayName: "Alex", interests: ["food", "history"], pace: "balanced", dietary: "none" };
    expect(joinTripSchema.safeParse(t).success).toBe(true);
  });
  it("rejects empty interests", () => {
    const t = { displayName: "Alex", interests: [], pace: "balanced", dietary: "none" };
    expect(joinTripSchema.safeParse(t).success).toBe(false);
  });
});

describe("createSuggestionSchema", () => {
  it("trims and accepts a member's place idea", () => {
    const result = createSuggestionSchema.safeParse({ token: "secret", text: "  Blue\nEye  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.text).toBe("Blue Eye");
  });

  it("rejects blank and overlong suggestions", () => {
    expect(createSuggestionSchema.safeParse({ token: "secret", text: "   " }).success).toBe(false);
    expect(createSuggestionSchema.safeParse({ token: "secret", text: "x".repeat(241) }).success).toBe(false);
  });
});

describe("conciergeChatSchema", () => {
  it("accepts a short conversation ending with a user question", () => {
    expect(conciergeChatSchema.safeParse({
      token: "secret",
      messages: [
        { role: "user", content: "Find a boat trip" },
        { role: "assistant", content: "What kind?" },
        { role: "user", content: "A sunset cruise" },
      ],
    }).success).toBe(true);
  });

  it("rejects conversations that do not end with a user question", () => {
    expect(conciergeChatSchema.safeParse({
      token: "secret",
      messages: [{ role: "assistant", content: "Hello" }],
    }).success).toBe(false);
  });
});

describe("reshuffleRequestSchema", () => {
  it("accepts a reviewed partial-day change and rejects an empty apply", () => {
    const base = {
      token: "secret",
      action: "apply-partial-day" as const,
      dayIndex: 2,
      currentBlock: "afternoon" as const,
      trigger: "running-late" as const,
      moves: [{
        itemId: "11111111-1111-4111-8111-111111111111",
        fromDayIndex: 2,
        fromBlock: "morning" as const,
        toDayIndex: 2,
        toBlock: "afternoon" as const,
      }],
      skips: [],
    };
    expect(reshuffleRequestSchema.safeParse(base).success).toBe(true);
    expect(reshuffleRequestSchema.safeParse({ ...base, moves: [] }).success).toBe(false);
  });
});

describe("updateReservationSchema", () => {
  const base = {
    token: "secret",
    slug: "summer",
    status: "confirmed" as const,
    reservationAt: "2026-08-20T17:30:00.000Z",
    confirmationNumber: "ABC-123",
    bookingUrl: "https://booking.example/reservation/123",
    cancellationDeadline: "2026-08-18T17:30:00.000Z",
  };

  it("accepts a complete confirmed reservation", () => {
    expect(updateReservationSchema.safeParse(base).success).toBe(true);
  });

  it("requires a confirmed reservation time", () => {
    expect(updateReservationSchema.safeParse({ ...base, reservationAt: null }).success).toBe(false);
  });

  it("rejects non-http booking links", () => {
    expect(updateReservationSchema.safeParse({ ...base, bookingUrl: "javascript:alert(1)" }).success).toBe(false);
  });

  it("allows removing all reservation data", () => {
    expect(updateReservationSchema.safeParse({
      ...base,
      status: "none",
      reservationAt: null,
      confirmationNumber: null,
      bookingUrl: null,
      cancellationDeadline: null,
    }).success).toBe(true);
  });
});
