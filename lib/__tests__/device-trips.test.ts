import { describe, it, expect } from "vitest";
import { readDeviceTrips, removeDeviceTrip, DEVICE_TRIP_LIMIT } from "@/lib/device-trips";

/** Stand-in for window.localStorage with the handful of members we use. */
function fakeStorage(entries: Record<string, string>) {
  const store = { ...entries };
  return {
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    getItem: (k: string) => store[k] ?? null,
    removeItem: (k: string) => {
      delete store[k];
    },
    snapshot: () => ({ ...store }),
  };
}

describe("readDeviceTrips", () => {
  it("returns one entry per stored trip token", () => {
    const storage = fakeStorage({ "tp:abc": "token-a", "tp:def": "token-b" });
    expect(readDeviceTrips(storage)).toEqual([
      { slug: "abc", token: "token-a" },
      { slug: "def", token: "token-b" },
    ]);
  });

  it("ignores keys that belong to other features", () => {
    const storage = fakeStorage({ "tp:abc": "token-a", theme: "dark", "other:xyz": "nope" });
    expect(readDeviceTrips(storage)).toEqual([{ slug: "abc", token: "token-a" }]);
  });

  it("skips entries with an empty slug or empty token", () => {
    const storage = fakeStorage({ "tp:abc": "token-a", "tp:": "orphan", "tp:def": "" });
    expect(readDeviceTrips(storage)).toEqual([{ slug: "abc", token: "token-a" }]);
  });

  it("returns nothing when the device has never joined a trip", () => {
    expect(readDeviceTrips(fakeStorage({}))).toEqual([]);
  });

  it("caps the batch so a pathological device cannot send an unbounded request", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < DEVICE_TRIP_LIMIT + 10; i++) many[`tp:slug${i}`] = `token${i}`;
    expect(readDeviceTrips(fakeStorage(many))).toHaveLength(DEVICE_TRIP_LIMIT);
  });
});

describe("removeDeviceTrip", () => {
  it("removes exactly the named trip and leaves the others alone", () => {
    const storage = fakeStorage({ "tp:abc": "token-a", "tp:def": "token-b" });
    removeDeviceTrip(storage, "abc");
    expect(storage.snapshot()).toEqual({ "tp:def": "token-b" });
  });
});
