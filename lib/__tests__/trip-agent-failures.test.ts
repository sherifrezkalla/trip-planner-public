import { describe, expect, it } from "vitest";
import * as contracts from "@/lib/trip-agent-contracts";

describe("closed public tool failures", () => {
  it("owns a nonempty message and boolean retryability for every catalog entry", () => {
    expect(contracts.TRIP_AGENT_FAILURE_CATALOG).toBeDefined();
    for (const [code, entry] of Object.entries(contracts.TRIP_AGENT_FAILURE_CATALOG)) {
      expect(entry.message.trim().length).toBeGreaterThan(0);
      expect(typeof entry.retryable).toBe("boolean");
      expect(entry.retryable).toBe(["rate_limited", "database_unavailable", "upstream_unavailable"].includes(code));
      expect(contracts.toolFailure(code)).toEqual({ ok: false, error: { code, ...entry } });
    }
  });

  it.each(["PRIVATE database detail", "__proto__", "constructor", "", "unknown_provider_failure"])("collapses untrusted code %s", code => {
    expect(contracts.toolFailure(code)).toEqual({ ok: false, error: {
      code: "database_unavailable", message: "The service is temporarily unavailable.", retryable: true,
    } });
  });

  it("permits only a terminal override", () => {
    expect(contracts.toolFailure("database_unavailable", { retryable: false }).error.retryable).toBe(false);
    expect(contracts.toolFailure("idempotency_conflict", { retryable: true } as never).error.retryable).toBe(false);
  });

  it.each([0, -1, 1.5, Infinity, NaN, 86401])("omits invalid retry-after %s", retryAfter => {
    expect(contracts.toolFailure("rate_limited", { retryAfter }).error).not.toHaveProperty("retryAfter");
  });

  it.each([1, 60, 86400])("accepts bounded retry-after %s", retryAfter => {
    expect(contracts.toolFailure("rate_limited", { retryAfter }).error.retryAfter).toBe(retryAfter);
  });
});
