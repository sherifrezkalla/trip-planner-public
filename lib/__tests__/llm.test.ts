import { describe, it, expect, vi } from "vitest";
import { callWithFallback, type Callers } from "@/lib/llm";

describe("callWithFallback", () => {
  it("returns primary result when primary succeeds", async () => {
    const callers: Callers = {
      primary: vi.fn().mockResolvedValue("primary says hi"),
      fallback: vi.fn().mockResolvedValue("fallback says hi"),
    };
    const result = await callWithFallback("prompt", callers);
    expect(result).toEqual({ text: "primary says hi", usedFallback: false });
    expect(callers.fallback).not.toHaveBeenCalled();
  });

  it("uses fallback when primary throws", async () => {
    const callers: Callers = {
      primary: vi.fn().mockRejectedValue(new Error("ollama rate limit")),
      fallback: vi.fn().mockResolvedValue("fallback says hi"),
    };
    const result = await callWithFallback("prompt", callers);
    expect(result).toEqual({ text: "fallback says hi", usedFallback: true });
  });

  it("rejects when both fail", async () => {
    const callers: Callers = {
      primary: vi.fn().mockRejectedValue(new Error("down")),
      fallback: vi.fn().mockRejectedValue(new Error("also down")),
    };
    await expect(callWithFallback("prompt", callers)).rejects.toThrow("also down");
  });
});
