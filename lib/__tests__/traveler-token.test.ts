import { describe, expect, it } from "vitest";
import { TRIP_TOKEN_HEADER, travelerTokenFrom } from "@/lib/auth";

/**
 * A traveller's token is not a session: it does not expire, it is their whole
 * identity on the trip, and it is the same string the re-attach link carries.
 * In a query string it is written verbatim into every access log the request
 * passes through, which turns a log line into a durable credential.
 */

const URL_BASE = "https://trip-planner.test/api/trips/example-coast";

function request(init: { header?: string; query?: string }): Request {
  const url = init.query === undefined ? URL_BASE : `${URL_BASE}?token=${init.query}`;
  return new Request(url, {
    headers: init.header === undefined ? {} : { [TRIP_TOKEN_HEADER]: init.header },
  });
}

describe("travelerTokenFrom", () => {
  it("reads the token from the header", () => {
    expect(travelerTokenFrom(request({ header: "tok" }))).toBe("tok");
  });

  /**
   * Required, not leftover. A tab opened before this deploys keeps running the
   * old client until it is reloaded; refusing its requests would sign people
   * out mid-trip to fix a logging problem.
   */
  it("still accepts a token in the query string", () => {
    expect(travelerTokenFrom(request({ query: "tok" }))).toBe("tok");
  });

  it("prefers the header when a request carries both", () => {
    expect(travelerTokenFrom(request({ header: "fromHeader", query: "fromQuery" })))
      .toBe("fromHeader");
  });

  it("falls back to the query string when the header is present but empty", () => {
    expect(travelerTokenFrom(request({ header: "   ", query: "tok" }))).toBe("tok");
  });

  it("returns an empty string when a request carries no token at all", () => {
    // Empty rather than null, because authTraveler treats it as a token that
    // matches no traveller and answers 401 — the same as any wrong token.
    expect(travelerTokenFrom(request({}))).toBe("");
    expect(travelerTokenFrom(request({ header: "  ", query: "  " }))).toBe("");
  });

  it("trims surrounding whitespace rather than passing it to the lookup", () => {
    expect(travelerTokenFrom(request({ header: "  tok  " }))).toBe("tok");
  });
});
