import { describe, it, expect } from "vitest";
import { planTimeoutMs, MAX_PLAN_TIMEOUT_MS } from "@/lib/generate";

describe("planTimeoutMs", () => {
  it("gives a short trip a modest budget", () => {
    expect(planTimeoutMs(3)).toBeLessThan(90_000);
  });

  it("gives a 13-day trip more than the 166s one actually measured", () => {
    // A 13-day plan is 52 blocks of JSON; measured at ~166s against GLM 5.2.
    expect(planTimeoutMs(13)).toBeGreaterThan(166_000);
  });

  it("grows with the number of days", () => {
    expect(planTimeoutMs(10)).toBeGreaterThan(planTimeoutMs(5));
  });

  it("never exceeds what a serverless function can survive", () => {
    expect(planTimeoutMs(60)).toBeLessThanOrEqual(MAX_PLAN_TIMEOUT_MS);
  });
});
