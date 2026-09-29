import { describe, it, expect } from "vitest";
import { makeSlug, makeToken } from "@/lib/ids";

const ALPHABET_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]+$/;

describe("ids", () => {
  it("makeSlug returns 10 chars from the safe alphabet", () => {
    const slug = makeSlug();
    expect(slug).toHaveLength(10);
    expect(slug).toMatch(ALPHABET_RE);
  });

  it("makeToken returns 32 chars from the safe alphabet", () => {
    const token = makeToken();
    expect(token).toHaveLength(32);
    expect(token).toMatch(ALPHABET_RE);
  });

  it("1000 slugs are unique", () => {
    const slugs = new Set(Array.from({ length: 1000 }, () => makeSlug()));
    expect(slugs.size).toBe(1000);
  });
});
