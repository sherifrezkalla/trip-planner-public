import { describe, expect, it, vi } from "vitest";
import {
  buildExposurePrompt,
  classifyExposure,
  parseExposureResponse,
  type VenueToClassify,
} from "@/lib/venue-exposure";

const venues: VenueToClassify[] = [
  { id: "a", name: "Musée océanographique de Monaco", category: "history" },
  { id: "b", name: "Place du Palais", category: "history" },
  { id: "c", name: "Marché Forville", category: "shopping" },
];

describe("buildExposurePrompt", () => {
  it("numbers the venues and names the closed vocabulary", () => {
    const prompt = buildExposurePrompt(venues);
    expect(prompt).toContain("1. Musée océanographique de Monaco (history)");
    expect(prompt).toContain("3. Marché Forville (shopping)");
    for (const word of ["indoor", "outdoor", "covered"]) expect(prompt).toContain(word);
  });
});

describe("parseExposureResponse", () => {
  it("reads a clean answer", () => {
    const parsed = parseExposureResponse("1|indoor\n2|outdoor\n3|covered", venues);
    expect(Object.fromEntries(parsed)).toEqual({ a: "indoor", b: "outdoor", c: "covered" });
  });

  it("tolerates whitespace and casing", () => {
    expect(parseExposureResponse("  1 | INDOOR  \n\n2|Outdoor", venues).get("a")).toBe("indoor");
    expect(parseExposureResponse("  1 | INDOOR  \n\n2|Outdoor", venues).get("b")).toBe("outdoor");
  });

  /**
   * The point of a line-per-venue format: one bad line costs one venue, not the
   * batch. A weak model is expected to produce some of these.
   */
  it("keeps the good lines and drops the rest", () => {
    const parsed = parseExposureResponse(
      "Sure! Here are the answers:\n1|indoor\n2|probably outdoors I think\n3|covered\nHope that helps",
      venues,
    );
    expect(Object.fromEntries(parsed)).toEqual({ a: "indoor", c: "covered" });
  });

  it("refuses a word outside the vocabulary", () => {
    expect(parseExposureResponse("1|semi-indoor\n2|inside", venues).size).toBe(0);
  });

  it("ignores a number that names no venue", () => {
    expect(Object.fromEntries(parseExposureResponse("9|indoor\n0|outdoor\n1|indoor", venues)))
      .toEqual({ a: "indoor" });
  });

  it("keeps the first answer when the model contradicts itself", () => {
    expect(parseExposureResponse("1|indoor\n1|outdoor", venues).get("a")).toBe("indoor");
  });
});

describe("classifyExposure", () => {
  it("classifies across batches", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `v${i}`, name: `Venue ${i}`, category: "food",
    }));
    const primary = vi.fn(async (prompt: string) => {
      const count = prompt.split("\n").filter((l) => /^\d+\. /.test(l)).length;
      return Array.from({ length: count }, (_, i) => `${i + 1}|indoor`).join("\n");
    });
    const result = await classifyExposure({ primary, fallback: primary }, many);

    expect(primary).toHaveBeenCalledTimes(2); // 25 + 5
    expect(result.size).toBe(30);
    expect(result.get("v29")).toBe("indoor");
  });

  /** A failed batch must not discard the batches that already worked. */
  it("keeps earlier batches when a later one fails outright", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `v${i}`, name: `Venue ${i}`, category: "food",
    }));
    let call = 0;
    const caller = vi.fn(async (prompt: string) => {
      // Batch 1 succeeds on its first (primary) call; every call after that
              // throws, so batch 2 fails on both primary and fallback.
              if (++call >= 2) throw new Error("model down");
      const count = prompt.split("\n").filter((l) => /^\d+\. /.test(l)).length;
      return Array.from({ length: count }, (_, i) => `${i + 1}|outdoor`).join("\n");
    });
    const result = await classifyExposure({ primary: caller, fallback: caller }, many);

    expect(result.size).toBe(25);
    expect(result.get("v0")).toBe("outdoor");
    expect(result.has("v29")).toBe(false);
  });
});
