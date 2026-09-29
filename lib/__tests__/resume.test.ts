import { describe, it, expect } from "vitest";
import { buildResumeUrl, parseResumeToken, RESUME_PARAM } from "@/lib/resume";

describe("buildResumeUrl", () => {
  it("puts the token in the fragment, where no server sees it", () => {
    expect(buildResumeUrl("https://example.com", "abc123", "tok")).toBe(
      `https://example.com/t/abc123/resume#${RESUME_PARAM}=tok`,
    );
  });

  /**
   * The point of the change: a browser sends the path and query to the server
   * and keeps the fragment to itself, so the request line is just
   * `GET /t/abc123/resume` and the token reaches no access log.
   */
  it("leaves nothing token-shaped in the part that is sent to the server", () => {
    const url = new URL(buildResumeUrl("https://example.com", "abc123", "sekrit"));

    expect(url.search).toBe("");
    expect(url.pathname).not.toContain("sekrit");
    expect(url.hash).toContain("sekrit");
  });

  it("encodes a token containing URL-significant characters", () => {
    const url = buildResumeUrl("https://example.com", "abc", "a+b/c=d&e");
    expect(url).not.toContain("a+b/c=d&e");
    expect(url).toContain(encodeURIComponent("a+b/c=d&e"));
  });

  it("tolerates an origin with a trailing slash", () => {
    expect(buildResumeUrl("https://example.com/", "abc", "tok")).toBe(
      `https://example.com/t/abc/resume#${RESUME_PARAM}=tok`,
    );
  });
});

describe("parseResumeToken", () => {
  it("reads the token out of the fragment", () => {
    expect(parseResumeToken("", `#${RESUME_PARAM}=tok`)).toBe("tok");
  });

  /**
   * Links minted before the move to fragments are already in people's messages.
   * Refusing them would break re-attaching for exactly the travellers who were
   * given a link early.
   */
  it("still reads a query-string link sent before the change", () => {
    expect(parseResumeToken(`?${RESUME_PARAM}=tok`)).toBe("tok");
    expect(parseResumeToken(`?${RESUME_PARAM}=tok`, "")).toBe("tok");
  });

  it("prefers the fragment when a URL somehow carries both", () => {
    // The fragment is the form that did not leak, so it wins.
    expect(parseResumeToken(`?${RESUME_PARAM}=fromQuery`, `#${RESUME_PARAM}=fromHash`))
      .toBe("fromHash");
  });

  it("returns null when the parameter is missing or blank", () => {
    expect(parseResumeToken("")).toBeNull();
    expect(parseResumeToken("?other=1")).toBeNull();
    expect(parseResumeToken(`?${RESUME_PARAM}=`)).toBeNull();
    expect(parseResumeToken(`?${RESUME_PARAM}=%20%20`)).toBeNull();
    expect(parseResumeToken("", `#${RESUME_PARAM}=`)).toBeNull();
    expect(parseResumeToken("", "#other=1")).toBeNull();
    expect(parseResumeToken("", "#")).toBeNull();
  });

  it("survives a build → parse round trip for an awkward token", () => {
    const token = "a+b/c=d&e f";
    const url = new URL(buildResumeUrl("https://example.com", "abc", token));

    expect(parseResumeToken(url.search, url.hash)).toBe(token);
  });
});
