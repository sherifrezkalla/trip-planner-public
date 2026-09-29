# Group Trip Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A destination-agnostic group trip planner: create a trip, share a magic link, everyone sets preferences, and a grounded two-stage pipeline (Google Places → LLM) generates a live, votable day-by-day itinerary.

**Architecture:** Next.js App Router on Vercel with thin API routes over independently-tested `lib/` modules. Supabase Postgres holds all state (service-role access only; RLS deny-all); browsers get live updates via Supabase Realtime *broadcast* channels (no direct table access). Generation is two-stage: `lib/places.ts` retrieves real venues, `lib/generate.ts` has the LLM arrange only those candidates into blocks, with validation → retry → model-fallback.

**Tech Stack:** Next.js 15 (App Router, TypeScript, Tailwind), Supabase (`@supabase/supabase-js`), Vercel AI SDK (`ai`, `@ai-sdk/openai-compatible` for Ollama Cloud GLM 5.2, `@ai-sdk/anthropic` for Sonnet 5 fallback), Google Places API (New), `@googlemaps/js-api-loader`, Zod, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-04-trip-planner-design.md` — refer to it for any ambiguity.
- Primary model `glm-5.2:cloud` via Ollama Cloud (OpenAI-compatible, base URL `https://ollama.com/v1`); fallback `claude-sonnet-5` via Anthropic API. Both env-configurable; **no model IDs hardcoded outside `lib/llm.ts` defaults.**
- LLM call timeout: 60 seconds per attempt.
- Venue rating filter: keep rating ≥ 4.0; relax to ≥ 3.5 when a category has < 3 candidates.
- Travel warning: consecutive itinerary stops > 5 km apart (haversine).
- Blocks enum everywhere: `morning | lunch | afternoon | dinner | evening`.
- Secrets are server-side env vars only. Browser-exposed vars limited to: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`.
- Browsers never read/write Supabase tables — API routes only. Realtime = broadcast channel `trip:{slug}`, event `updated`, consumed as "refetch board now".
- All new code TypeScript strict. Tests colocated in `lib/__tests__/`. Run tests with `npm test` (vitest run).
- Commit after every green test cycle.

---

### Task 1: Project scaffold

**Files:**
- Create: Next.js app in repo root (via create-next-app), `vitest.config.ts`, `.env.example`
- Modify: `package.json` (test script)

**Interfaces:**
- Produces: a running Next.js 15 TypeScript app with Tailwind, `@/*` import alias, vitest wired up.

- [ ] **Step 1: Scaffold Next.js into the existing repo**

```bash
cd "/path/to/trip-planner"
npx create-next-app@latest .tmp-scaffold --ts --app --tailwind --eslint --no-src-dir --import-alias "@/*" --use-npm
rm -rf .tmp-scaffold/.git
rsync -a .tmp-scaffold/ .
rm -rf .tmp-scaffold
npm install
```

- [ ] **Step 2: Install dependencies**

```bash
npm install ai @ai-sdk/openai-compatible @ai-sdk/anthropic @supabase/supabase-js zod @googlemaps/js-api-loader
npm install -D vitest
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/__tests__/**/*.test.ts", "app/**/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});
```

- [ ] **Step 4: Add test script to `package.json`**

In `package.json` `"scripts"`, add: `"test": "vitest run"`.

- [ ] **Step 5: Create `.env.example`**

```bash
# LLM
LLM_PROVIDER=ollama            # ollama | anthropic (which model is PRIMARY)
OLLAMA_BASE_URL=https://ollama.com/v1
OLLAMA_API_KEY=
OLLAMA_MODEL=glm-5.2:cloud
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-5

# Google (server key: Places API (New); browser key: Maps JavaScript API, referrer-restricted)
GOOGLE_MAPS_API_KEY=
NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

- [ ] **Step 6: Verify the app builds and tests run**

```bash
npm run build        # Expected: build succeeds
npm test             # Expected: "No test files found" exit 0 (or passWithNoTests notice)
```
If vitest exits non-zero on no tests, add `passWithNoTests: true` inside the `test` block of `vitest.config.ts`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold Next.js app with vitest and dependencies"
```

---

### Task 2: Database migration

**Files:**
- Create: `supabase/migrations/0001_init.sql`

**Interfaces:**
- Produces: tables `trips`, `travelers`, `venue_candidates`, `itinerary_items`, `votes` (all RLS-enabled, zero policies = deny-all for anon; service role bypasses RLS).

- [ ] **Step 1: Write the migration**

```sql
create extension if not exists "pgcrypto";

create table trips (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  destination_name text not null,
  destination_place_id text not null,
  lat double precision not null,
  lng double precision not null,
  start_date date not null,
  end_date date not null,
  budget_level text not null check (budget_level in ('low','mid','high')),
  vibe_note text not null default '',
  created_at timestamptz not null default now()
);

create table travelers (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  display_name text not null,
  token text not null unique,
  interests text[] not null,
  pace text not null check (pace in ('chill','balanced','packed')),
  dietary text not null,
  constraints_note text not null default '',
  is_organizer boolean not null default false,
  created_at timestamptz not null default now()
);

create table venue_candidates (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  place_id text not null,
  name text not null,
  category text not null,
  rating double precision,
  review_count integer not null default 0,
  price_level text,
  opening_hours jsonb not null default '[]',
  lat double precision not null,
  lng double precision not null,
  maps_url text not null default '',
  fetched_at timestamptz not null default now(),
  unique (trip_id, place_id)
);

create table itinerary_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  day_index integer not null,
  block text not null check (block in ('morning','lunch','afternoon','dinner','evening')),
  candidate_id uuid not null references venue_candidates(id),
  why_note text not null default '',
  duration_min integer not null,
  position integer not null default 0,
  travel_warning boolean not null default false,
  created_at timestamptz not null default now()
);

create table votes (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references itinerary_items(id) on delete cascade,
  traveler_id uuid not null references travelers(id) on delete cascade,
  value smallint not null check (value in (-1, 1)),
  unique (item_id, traveler_id)
);

alter table trips enable row level security;
alter table travelers enable row level security;
alter table venue_candidates enable row level security;
alter table itinerary_items enable row level security;
alter table votes enable row level security;
-- Intentionally no policies: deny-all. Only the service role (API routes) touches tables.
```

- [ ] **Step 2: Apply the migration**

Create a new Supabase project named `trip-planner` (do NOT reuse the Open Brain project). Then paste `supabase/migrations/0001_init.sql` into the Supabase dashboard SQL editor and run it.
Expected: "Success. No rows returned". Verify all 5 tables appear under Table Editor with the RLS badge enabled.

- [ ] **Step 3: Commit**

```bash
git add supabase && git commit -m "feat: initial database schema with deny-all RLS"
```

---

### Task 3: ID generation (`lib/ids.ts`)

**Files:**
- Create: `lib/ids.ts`
- Test: `lib/__tests__/ids.test.ts`

**Interfaces:**
- Produces: `makeSlug(): string` (10 chars) and `makeToken(): string` (32 chars), both from an unambiguous base-58-style alphabet.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/__tests__/ids.test.ts`
Expected: FAIL — cannot resolve `@/lib/ids`.

- [ ] **Step 3: Implement `lib/ids.ts`**

```ts
import { randomBytes } from "node:crypto";

// No 0/O, 1/l/I — safe for reading aloud and typing.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function makeSlug(): string {
  return randomString(10);
}

export function makeToken(): string {
  return randomString(32);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/__tests__/ids.test.ts` — Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add lib && git commit -m "feat: slug and token generation"
```

---

### Task 4: Schemas and shared types (`lib/schema.ts`)

**Files:**
- Create: `lib/schema.ts`
- Test: `lib/__tests__/schema.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - `BLOCKS`, `INTERESTS` const arrays; types `Block`, `Interest`
  - `itineraryPlanSchema` / type `ItineraryPlan` — `{ days: { dayIndex: number; blocks: { block: Block; candidateId: string; whyNote: string; durationMin: number }[] }[] }`
  - `swapBlockSchema` / type `SwapBlock` — `{ candidateId: string; whyNote: string; durationMin: number }`
  - `createTripSchema`, `joinTripSchema`, `voteSchema` (API payload validation)
  - `type TripMeta = { destinationName: string; startDate: string; endDate: string; budgetLevel: "low"|"mid"|"high"; vibeNote: string; dayCount: number }`
  - `type TravelerPrefs = { displayName: string; interests: string[]; pace: string; dietary: string; constraintsNote: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import {
  itineraryPlanSchema,
  swapBlockSchema,
  createTripSchema,
  joinTripSchema,
} from "@/lib/schema";

const validPlan = {
  days: [
    {
      dayIndex: 0,
      blocks: [
        { block: "morning", candidateId: "abc", whyNote: "for the history fans", durationMin: 120 },
        { block: "lunch", candidateId: "def", whyNote: "vegetarian friendly", durationMin: 60 },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/__tests__/schema.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/schema.ts`**

```ts
import { z } from "zod";

export const BLOCKS = ["morning", "lunch", "afternoon", "dinner", "evening"] as const;
export type Block = (typeof BLOCKS)[number];

export const INTERESTS = ["food", "history", "nature", "nightlife", "shopping", "art", "water", "active"] as const;
export type Interest = (typeof INTERESTS)[number];

export const itineraryPlanSchema = z.object({
  days: z
    .array(
      z.object({
        dayIndex: z.number().int().min(0),
        blocks: z.array(
          z.object({
            block: z.enum(BLOCKS),
            candidateId: z.string().min(1),
            whyNote: z.string(),
            durationMin: z.number().int().positive(),
          }),
        ),
      }),
    )
    .min(1),
});
export type ItineraryPlan = z.infer<typeof itineraryPlanSchema>;

export const swapBlockSchema = z.object({
  candidateId: z.string().min(1),
  whyNote: z.string(),
  durationMin: z.number().int().positive(),
});
export type SwapBlock = z.infer<typeof swapBlockSchema>;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const createTripSchema = z
  .object({
    destinationName: z.string().min(1).max(120),
    destinationPlaceId: z.string().min(1),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    startDate: dateString,
    endDate: dateString,
    budgetLevel: z.enum(["low", "mid", "high"]),
    vibeNote: z.string().max(500).optional().default(""),
  })
  .refine((t) => t.endDate >= t.startDate, { message: "endDate must be on or after startDate" });
export type CreateTrip = z.infer<typeof createTripSchema>;

export const joinTripSchema = z.object({
  displayName: z.string().min(1).max(50),
  interests: z.array(z.enum(INTERESTS)).min(1),
  pace: z.enum(["chill", "balanced", "packed"]),
  dietary: z.enum(["none", "vegetarian", "vegan", "halal", "other"]),
  constraintsNote: z.string().max(300).optional().default(""),
});
export type JoinTrip = z.infer<typeof joinTripSchema>;

export const voteSchema = z.object({
  slug: z.string().min(1),
  token: z.string().min(1),
  value: z.union([z.literal(1), z.literal(-1)]),
});

export type TripMeta = {
  destinationName: string;
  startDate: string;
  endDate: string;
  budgetLevel: "low" | "mid" | "high";
  vibeNote: string;
  dayCount: number;
};

export type TravelerPrefs = {
  displayName: string;
  interests: string[];
  pace: string;
  dietary: string;
  constraintsNote: string;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/__tests__/schema.test.ts` — Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add lib && git commit -m "feat: zod schemas and shared types"
```

---

### Task 5: LLM client with fallback (`lib/llm.ts`)

**Files:**
- Create: `lib/llm.ts`
- Test: `lib/__tests__/llm.test.ts`

**Interfaces:**
- Consumes: env vars from `.env.example` (Task 1).
- Produces:
  - `type LlmCaller = (prompt: string) => Promise<string>`
  - `type Callers = { primary: LlmCaller; fallback: LlmCaller }`
  - `getCallers(): Callers` — builds real callers from env (Ollama Cloud primary unless `LLM_PROVIDER=anthropic`; Anthropic always the fallback).
  - `callWithFallback(prompt: string, callers: Callers): Promise<{ text: string; usedFallback: boolean }>`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/__tests__/llm.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/llm.ts`**

```ts
import { generateText, type LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";

export type LlmCaller = (prompt: string) => Promise<string>;
export type Callers = { primary: LlmCaller; fallback: LlmCaller };

const TIMEOUT_MS = 60_000;

function makeCaller(model: LanguageModel): LlmCaller {
  return async (prompt: string) => {
    const { text } = await generateText({
      model,
      prompt,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return text;
  };
}

export function getCallers(): Callers {
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const fallbackModel = anthropic(process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5");

  const ollama = createOpenAICompatible({
    name: "ollama",
    baseURL: process.env.OLLAMA_BASE_URL ?? "https://ollama.com/v1",
    apiKey: process.env.OLLAMA_API_KEY,
  });
  const primaryModel =
    process.env.LLM_PROVIDER === "anthropic"
      ? fallbackModel
      : ollama(process.env.OLLAMA_MODEL ?? "glm-5.2:cloud");

  return { primary: makeCaller(primaryModel), fallback: makeCaller(fallbackModel) };
}

export async function callWithFallback(
  prompt: string,
  callers: Callers,
): Promise<{ text: string; usedFallback: boolean }> {
  try {
    return { text: await callers.primary(prompt), usedFallback: false };
  } catch {
    return { text: await callers.fallback(prompt), usedFallback: true };
  }
}
```

If `LanguageModel` is not an exported type name in the installed `ai` version, run `npx tsc --noEmit` and use the type the compiler suggests (e.g. `LanguageModelV2`) — do not guess further names.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/__tests__/llm.test.ts` — Expected: 3 passed. Also run `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib && git commit -m "feat: LLM callers with GLM primary and Sonnet fallback"
```

---

### Task 6: Google Places retrieval (`lib/places.ts`)

**Files:**
- Create: `lib/places.ts`
- Test: `lib/__tests__/places.test.ts`

**Interfaces:**
- Produces:
  - `type PlaceCandidate = { placeId: string; name: string; category: string; rating: number | null; reviewCount: number; priceLevel: string | null; openingHours: string[]; lat: number; lng: number; mapsUrl: string }`
  - `buildCategoryQueries(interests: string[], dietaryList: string[]): { category: string; query: string }[]`
  - `searchPlaces(args: { query: string; category: string; lat: number; lng: number; apiKey: string; fetchImpl?: typeof fetch }): Promise<PlaceCandidate[]>`
  - `filterByRating(candidates: PlaceCandidate[]): PlaceCandidate[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { buildCategoryQueries, searchPlaces, filterByRating, type PlaceCandidate } from "@/lib/places";

function cand(overrides: Partial<PlaceCandidate>): PlaceCandidate {
  return {
    placeId: "p1", name: "Place", category: "food", rating: 4.5, reviewCount: 100,
    priceLevel: null, openingHours: [], lat: 0, lng: 0, mapsUrl: "", ...overrides,
  };
}

describe("buildCategoryQueries", () => {
  it("dedupes interests and always adds restaurant + breakfast", () => {
    const qs = buildCategoryQueries(["food", "food", "history"], ["none"]);
    const categories = qs.map((q) => q.category);
    expect(categories).toEqual(["food", "history", "restaurant", "breakfast"]);
  });
  it("uses vegetarian-friendly restaurant query when any traveler is vegetarian or vegan", () => {
    const qs = buildCategoryQueries(["food"], ["none", "vegan"]);
    const restaurant = qs.find((q) => q.category === "restaurant")!;
    expect(restaurant.query).toContain("vegetarian");
  });
});

describe("searchPlaces", () => {
  const apiResponse = {
    places: [
      {
        id: "gp_1",
        displayName: { text: "Time Out Market" },
        rating: 4.6,
        userRatingCount: 90000,
        priceLevel: "PRICE_LEVEL_MODERATE",
        location: { latitude: 38.707, longitude: -9.146 },
        googleMapsUri: "https://maps.google.com/?cid=1",
        regularOpeningHours: { weekdayDescriptions: ["Monday: 10:00 AM – 12:00 AM"] },
        businessStatus: "OPERATIONAL",
      },
      { id: "gp_2", displayName: { text: "Closed Spot" }, businessStatus: "CLOSED_PERMANENTLY" },
    ],
  };

  it("maps the Places response and drops non-operational venues", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(apiResponse), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await searchPlaces({
      query: "food market", category: "food", lat: 38.72, lng: -9.14, apiKey: "k", fetchImpl,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      placeId: "gp_1",
      name: "Time Out Market",
      category: "food",
      rating: 4.6,
      openingHours: ["Monday: 10:00 AM – 12:00 AM"],
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("k");
  });

  it("throws on a non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("quota", { status: 429 })) as unknown as typeof fetch;
    await expect(
      searchPlaces({ query: "q", category: "c", lat: 0, lng: 0, apiKey: "k", fetchImpl }),
    ).rejects.toThrow("Places API 429");
  });
});

describe("filterByRating", () => {
  it("keeps only rating >= 4.0 when 3 or more qualify", () => {
    const cands = [cand({ placeId: "a", rating: 4.5 }), cand({ placeId: "b", rating: 4.0 }),
      cand({ placeId: "c", rating: 4.2 }), cand({ placeId: "d", rating: 3.6 })];
    expect(filterByRating(cands).map((c) => c.placeId)).toEqual(["a", "b", "c"]);
  });
  it("relaxes to 3.5 when fewer than 3 strong candidates", () => {
    const cands = [cand({ placeId: "a", rating: 4.1 }), cand({ placeId: "b", rating: 3.7 }),
      cand({ placeId: "c", rating: 3.2 })];
    expect(filterByRating(cands).map((c) => c.placeId)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/__tests__/places.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/places.ts`**

```ts
export type PlaceCandidate = {
  placeId: string;
  name: string;
  category: string;
  rating: number | null;
  reviewCount: number;
  priceLevel: string | null;
  openingHours: string[];
  lat: number;
  lng: number;
  mapsUrl: string;
};

const INTEREST_QUERIES: Record<string, string> = {
  food: "famous food market or local specialty restaurant",
  history: "historical landmark or museum",
  nature: "park or nature attraction",
  nightlife: "popular bar or nightlife venue",
  shopping: "shopping street or market",
  art: "art gallery or cultural site",
  water: "beach or waterfront attraction",
  active: "outdoor activity or sports venue",
};

export function buildCategoryQueries(
  interests: string[],
  dietaryList: string[],
): { category: string; query: string }[] {
  const unique = [...new Set(interests)].filter((i) => INTEREST_QUERIES[i]);
  const queries = unique.map((i) => ({ category: i, query: INTEREST_QUERIES[i] }));
  const veg = dietaryList.some((d) => d === "vegetarian" || d === "vegan");
  queries.push({
    category: "restaurant",
    query: veg ? "highly rated vegetarian friendly restaurant" : "highly rated restaurant for dinner",
  });
  queries.push({ category: "breakfast", query: "breakfast cafe" });
  return queries;
}

type PlacesApiPlace = {
  id: string;
  displayName?: { text?: string };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  location?: { latitude?: number; longitude?: number };
  googleMapsUri?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  businessStatus?: string;
};

export async function searchPlaces(args: {
  query: string;
  category: string;
  lat: number;
  lng: number;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<PlaceCandidate[]> {
  const f = args.fetchImpl ?? fetch;
  const res = await f("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": args.apiKey,
      "X-Goog-FieldMask": [
        "places.id",
        "places.displayName",
        "places.rating",
        "places.userRatingCount",
        "places.priceLevel",
        "places.location",
        "places.googleMapsUri",
        "places.regularOpeningHours.weekdayDescriptions",
        "places.businessStatus",
      ].join(","),
    },
    body: JSON.stringify({
      textQuery: args.query,
      pageSize: 20,
      locationBias: {
        circle: { center: { latitude: args.lat, longitude: args.lng }, radius: 15000 },
      },
    }),
  });
  if (!res.ok) throw new Error(`Places API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { places?: PlacesApiPlace[] };
  return (data.places ?? [])
    .filter((p) => p.businessStatus === "OPERATIONAL" || p.businessStatus === undefined)
    .map(
      (p): PlaceCandidate => ({
        placeId: p.id,
        name: p.displayName?.text ?? "Unknown",
        category: args.category,
        rating: p.rating ?? null,
        reviewCount: p.userRatingCount ?? 0,
        priceLevel: p.priceLevel ?? null,
        openingHours: p.regularOpeningHours?.weekdayDescriptions ?? [],
        lat: p.location?.latitude ?? 0,
        lng: p.location?.longitude ?? 0,
        mapsUrl: p.googleMapsUri ?? "",
      }),
    );
}

export function filterByRating(candidates: PlaceCandidate[]): PlaceCandidate[] {
  const strong = candidates.filter((c) => (c.rating ?? 0) >= 4.0);
  if (strong.length >= 3) return strong;
  return candidates.filter((c) => (c.rating ?? 0) >= 3.5);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/__tests__/places.test.ts` — Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add lib && git commit -m "feat: Google Places retrieval, category queries, rating filter"
```

---

### Task 7: Generation pipeline (`lib/generate.ts`)

**Files:**
- Create: `lib/generate.ts`
- Test: `lib/__tests__/generate.test.ts`

**Interfaces:**
- Consumes: `PlaceCandidate` (Task 6), `Callers` (Task 5), `itineraryPlanSchema`/`swapBlockSchema`/`TripMeta`/`TravelerPrefs` (Task 4).
- Produces:
  - `extractJson(text: string): unknown`
  - `validatePlan(plan: ItineraryPlan, candidateIds: Set<string>, dayCount: number): string[]`
  - `haversineKm(a: {lat:number;lng:number}, b: {lat:number;lng:number}): number`
  - `travelWarnings(plan: ItineraryPlan, byId: Map<string, PlaceCandidate>): Set<string>` — returns candidateIds of blocks whose leg FROM the previous stop is > 5 km
  - `buildPrompt(args: { trip: TripMeta; travelers: TravelerPrefs[]; candidates: PlaceCandidate[] }): string`
  - `arrangePlan(args: { trip: TripMeta; travelers: TravelerPrefs[]; candidates: PlaceCandidate[]; callers: Callers }): Promise<{ plan: ItineraryPlan; usedFallback: boolean }>`
  - `arrangeSwap(args: { trip: TripMeta; travelers: TravelerPrefs[]; allowed: PlaceCandidate[]; block: Block; dayIndex: number; callers: Callers }): Promise<{ swap: SwapBlock; usedFallback: boolean }>`

**Note on IDs:** in production callers (Task 9), `PlaceCandidate.placeId` is set to the `venue_candidates.id` **row UUID** (not the Google place id) before prompting, so validated `candidateId`s can be written straight into `itinerary_items.candidate_id`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import {
  extractJson, validatePlan, haversineKm, travelWarnings, arrangePlan, arrangeSwap,
} from "@/lib/generate";
import type { PlaceCandidate } from "@/lib/places";
import type { TripMeta, TravelerPrefs, ItineraryPlan } from "@/lib/schema";

const trip: TripMeta = {
  destinationName: "Lisbon", startDate: "2026-09-10", endDate: "2026-09-11",
  budgetLevel: "mid", vibeNote: "", dayCount: 2,
};
const travelers: TravelerPrefs[] = [
  { displayName: "A", interests: ["food"], pace: "balanced", dietary: "vegetarian", constraintsNote: "" },
];
function cand(id: string, lat = 38.7, lng = -9.14): PlaceCandidate {
  return {
    placeId: id, name: `Venue ${id}`, category: "food", rating: 4.5, reviewCount: 10,
    priceLevel: null, openingHours: ["Monday: 9 AM – 6 PM"], lat, lng, mapsUrl: "",
  };
}
const candidates = [cand("c1"), cand("c2"), cand("c3"), cand("c4")];

function planJson(ids: [string, string, string, string]): string {
  return JSON.stringify({
    days: [
      { dayIndex: 0, blocks: [
        { block: "morning", candidateId: ids[0], whyNote: "w", durationMin: 120 },
        { block: "lunch", candidateId: ids[1], whyNote: "w", durationMin: 60 },
      ]},
      { dayIndex: 1, blocks: [
        { block: "morning", candidateId: ids[2], whyNote: "w", durationMin: 120 },
        { block: "lunch", candidateId: ids[3], whyNote: "w", durationMin: 60 },
      ]},
    ],
  });
}

describe("extractJson", () => {
  it("parses JSON wrapped in markdown fences and prose", () => {
    const text = 'Here you go:\n```json\n{"a": 1}\n```\nEnjoy!';
    expect(extractJson(text)).toEqual({ a: 1 });
  });
  it("throws when no JSON object present", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("validatePlan", () => {
  const ids = new Set(["c1", "c2", "c3", "c4"]);
  it("returns no errors for a valid plan", () => {
    const plan = JSON.parse(planJson(["c1", "c2", "c3", "c4"])) as ItineraryPlan;
    expect(validatePlan(plan, ids, 2)).toEqual([]);
  });
  it("flags unknown candidate ids", () => {
    const plan = JSON.parse(planJson(["c1", "cX", "c3", "c4"])) as ItineraryPlan;
    expect(validatePlan(plan, ids, 2).join(" ")).toContain("cX");
  });
  it("flags duplicate venues and wrong day count", () => {
    const plan = JSON.parse(planJson(["c1", "c1", "c3", "c4"])) as ItineraryPlan;
    const errors = validatePlan(plan, ids, 3);
    expect(errors.some((e) => e.includes("Duplicate"))).toBe(true);
    expect(errors.some((e) => e.includes("Expected 3 days"))).toBe(true);
  });
});

describe("haversineKm", () => {
  it("computes ~0 for identical points and a sane city-scale distance", () => {
    expect(haversineKm({ lat: 38.7, lng: -9.14 }, { lat: 38.7, lng: -9.14 })).toBeCloseTo(0);
    const km = haversineKm({ lat: 38.7071, lng: -9.1355 }, { lat: 38.7223, lng: -9.1393 });
    expect(km).toBeGreaterThan(1);
    expect(km).toBeLessThan(3);
  });
});

describe("travelWarnings", () => {
  it("flags a leg longer than 5 km", () => {
    const far = cand("c2", 38.9, -9.14); // ~22 km north
    const byId = new Map([["c1", cand("c1")], ["c2", far]]);
    const plan = {
      days: [{ dayIndex: 0, blocks: [
        { block: "morning", candidateId: "c1", whyNote: "", durationMin: 60 },
        { block: "lunch", candidateId: "c2", whyNote: "", durationMin: 60 },
      ]}],
    } as ItineraryPlan;
    expect(travelWarnings(plan, byId)).toEqual(new Set(["c2"]));
  });
});

describe("arrangePlan", () => {
  it("returns the plan from the primary on the first valid answer", async () => {
    const callers = {
      primary: vi.fn().mockResolvedValue(planJson(["c1", "c2", "c3", "c4"])),
      fallback: vi.fn(),
    };
    const { plan, usedFallback } = await arrangePlan({ trip, travelers, candidates, callers });
    expect(usedFallback).toBe(false);
    expect(plan.days).toHaveLength(2);
    expect(callers.primary).toHaveBeenCalledTimes(1);
  });

  it("retries the primary once with validation errors, then succeeds", async () => {
    const callers = {
      primary: vi.fn()
        .mockResolvedValueOnce(planJson(["cX", "c2", "c3", "c4"]))
        .mockResolvedValueOnce(planJson(["c1", "c2", "c3", "c4"])),
      fallback: vi.fn(),
    };
    const { usedFallback } = await arrangePlan({ trip, travelers, candidates, callers });
    expect(usedFallback).toBe(false);
    expect(callers.primary).toHaveBeenCalledTimes(2);
    const retryPrompt = callers.primary.mock.calls[1][0] as string;
    expect(retryPrompt).toContain("cX"); // errors fed back
  });

  it("falls back to the fallback model when the primary keeps failing validation", async () => {
    const callers = {
      primary: vi.fn().mockResolvedValue(planJson(["cX", "c2", "c3", "c4"])),
      fallback: vi.fn().mockResolvedValue(planJson(["c1", "c2", "c3", "c4"])),
    };
    const { usedFallback } = await arrangePlan({ trip, travelers, candidates, callers });
    expect(usedFallback).toBe(true);
  });

  it("falls back when the primary throws (transport error)", async () => {
    const callers = {
      primary: vi.fn().mockRejectedValue(new Error("timeout")),
      fallback: vi.fn().mockResolvedValue(planJson(["c1", "c2", "c3", "c4"])),
    };
    const { usedFallback } = await arrangePlan({ trip, travelers, candidates, callers });
    expect(usedFallback).toBe(true);
    expect(callers.primary).toHaveBeenCalledTimes(1); // no retry after transport error
  });

  it("throws PLAN_GENERATION_FAILED when everything fails", async () => {
    const callers = {
      primary: vi.fn().mockResolvedValue("not json"),
      fallback: vi.fn().mockResolvedValue("still not json"),
    };
    await expect(arrangePlan({ trip, travelers, candidates, callers })).rejects.toThrow(
      "PLAN_GENERATION_FAILED",
    );
  });
});

describe("arrangeSwap", () => {
  it("returns a validated swap from the primary", async () => {
    const callers = {
      primary: vi.fn().mockResolvedValue('{"candidateId":"c3","whyNote":"better fit","durationMin":90}'),
      fallback: vi.fn(),
    };
    const { swap, usedFallback } = await arrangeSwap({
      trip, travelers, allowed: [cand("c3"), cand("c4")], block: "lunch", dayIndex: 0, callers,
    });
    expect(usedFallback).toBe(false);
    expect(swap.candidateId).toBe("c3");
  });

  it("uses the fallback when the primary picks a disallowed venue", async () => {
    const callers = {
      primary: vi.fn().mockResolvedValue('{"candidateId":"c9","whyNote":"x","durationMin":90}'),
      fallback: vi.fn().mockResolvedValue('{"candidateId":"c4","whyNote":"y","durationMin":60}'),
    };
    const { swap, usedFallback } = await arrangeSwap({
      trip, travelers, allowed: [cand("c3"), cand("c4")], block: "lunch", dayIndex: 0, callers,
    });
    expect(usedFallback).toBe(true);
    expect(swap.candidateId).toBe("c4");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/__tests__/generate.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/generate.ts`**

```ts
import type { PlaceCandidate } from "./places";
import type { Callers } from "./llm";
import {
  itineraryPlanSchema, swapBlockSchema,
  type Block, type ItineraryPlan, type SwapBlock, type TripMeta, type TravelerPrefs,
} from "./schema";

export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object found in LLM output");
  return JSON.parse(text.slice(start, end + 1));
}

export function validatePlan(
  plan: ItineraryPlan,
  candidateIds: Set<string>,
  dayCount: number,
): string[] {
  const errors: string[] = [];
  if (plan.days.length !== dayCount) {
    errors.push(`Expected ${dayCount} days, got ${plan.days.length}`);
  }
  const used = new Set<string>();
  for (const day of plan.days) {
    for (const b of day.blocks) {
      if (!candidateIds.has(b.candidateId)) {
        errors.push(`Unknown candidateId "${b.candidateId}" on day ${day.dayIndex} — use only ids from the venue list`);
      }
      if (used.has(b.candidateId)) errors.push(`Duplicate venue "${b.candidateId}" — each venue at most once`);
      used.add(b.candidateId);
    }
  }
  return errors;
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const WARN_KM = 5;

export function travelWarnings(
  plan: ItineraryPlan,
  byId: Map<string, PlaceCandidate>,
): Set<string> {
  const flagged = new Set<string>();
  for (const day of plan.days) {
    for (let i = 1; i < day.blocks.length; i++) {
      const prev = byId.get(day.blocks[i - 1].candidateId);
      const curr = byId.get(day.blocks[i].candidateId);
      if (prev && curr && haversineKm(prev, curr) > WARN_KM) flagged.add(curr.placeId);
    }
  }
  return flagged;
}

function candidateLines(candidates: PlaceCandidate[]): string {
  return candidates
    .map(
      (c) =>
        `${c.placeId} | ${c.name} | ${c.category} | rating ${c.rating ?? "n/a"} (${c.reviewCount} reviews) | price ${c.priceLevel ?? "n/a"} | hours: ${c.openingHours.join("; ") || "unknown"}`,
    )
    .join("\n");
}

function travelerLines(travelers: TravelerPrefs[]): string {
  return travelers
    .map(
      (t) =>
        `- ${t.displayName}: interests=${t.interests.join(",")}; pace=${t.pace}; dietary=${t.dietary}; notes=${t.constraintsNote || "none"}`,
    )
    .join("\n");
}

export function buildPrompt(args: {
  trip: TripMeta;
  travelers: TravelerPrefs[];
  candidates: PlaceCandidate[];
}): string {
  const { trip } = args;
  return `You are a meticulous travel planner. Create a ${trip.dayCount}-day itinerary for ${trip.destinationName} (${trip.startDate} to ${trip.endDate}, budget: ${trip.budgetLevel}${trip.vibeNote ? `, vibe: ${trip.vibeNote}` : ""}).

TRAVELERS:
${travelerLines(args.travelers)}

VENUES — the ONLY places you may use; reference each by the exact id in the first column:
${candidateLines(args.candidates)}

RULES:
- Output ONLY a JSON object, no prose, exactly this shape:
  {"days":[{"dayIndex":0,"blocks":[{"block":"morning","candidateId":"<id>","whyNote":"<one line>","durationMin":120}]}]}
- days must cover dayIndex 0 through ${trip.dayCount - 1}, in order.
- Each day has blocks in this order: morning, lunch, afternoon, dinner. Add an evening block only if the group's pace is "packed" or nightlife is a shared interest.
- lunch and dinner blocks must use restaurants/cafes suitable for every dietary need listed above.
- Never schedule a venue at a time its opening hours say it is closed.
- Use each venue at most once. Never invent a venue or id.
- Balance interests across the whole group over the trip; each whyNote says who the pick is for.
- pace chill = fewer stops with longer durations; packed = fuller days.`;
}

export function buildSwapPrompt(args: {
  trip: TripMeta;
  travelers: TravelerPrefs[];
  allowed: PlaceCandidate[];
  block: Block;
  dayIndex: number;
}): string {
  return `You are a travel planner adjusting one slot in an existing ${args.trip.dayCount}-day ${args.trip.destinationName} itinerary.

TRAVELERS:
${travelerLines(args.travelers)}

Pick ONE venue for the "${args.block}" block on day ${args.dayIndex} from this list ONLY (reference by the exact id in the first column):
${candidateLines(args.allowed)}

Output ONLY a JSON object, no prose, exactly:
{"candidateId":"<id>","whyNote":"<one line>","durationMin":90}
${args.block === "lunch" || args.block === "dinner" ? "The venue must suit every dietary need listed above." : ""}`;
}

type AttemptResult = { plan: ItineraryPlan } | { errors: string[] };

async function attemptPlan(
  caller: (prompt: string) => Promise<string>,
  prompt: string,
  candidateIds: Set<string>,
  dayCount: number,
): Promise<AttemptResult> {
  const text = await caller(prompt); // transport errors propagate to the caller
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return { errors: ["Output was not a valid JSON object"] };
  }
  const parsed = itineraryPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const errors = validatePlan(parsed.data, candidateIds, dayCount);
  return errors.length ? { errors } : { plan: parsed.data };
}

function withErrors(prompt: string, errors: string[]): string {
  return `${prompt}\n\nYour previous answer had these problems — fix ALL of them:\n- ${errors.join("\n- ")}`;
}

export async function arrangePlan(args: {
  trip: TripMeta;
  travelers: TravelerPrefs[];
  candidates: PlaceCandidate[];
  callers: Callers;
}): Promise<{ plan: ItineraryPlan; usedFallback: boolean }> {
  const ids = new Set(args.candidates.map((c) => c.placeId));
  const basePrompt = buildPrompt(args);
  let lastErrors: string[] = [];

  // Attempt 1: primary. Attempt 2: primary retry with validation errors.
  try {
    const r1 = await attemptPlan(args.callers.primary, basePrompt, ids, args.trip.dayCount);
    if ("plan" in r1) return { plan: r1.plan, usedFallback: false };
    lastErrors = r1.errors;
    const r2 = await attemptPlan(
      args.callers.primary, withErrors(basePrompt, lastErrors), ids, args.trip.dayCount,
    );
    if ("plan" in r2) return { plan: r2.plan, usedFallback: false };
    lastErrors = r2.errors;
  } catch {
    // transport error on primary — go straight to fallback
  }

  // Attempt 3: fallback model.
  const fbPrompt = lastErrors.length ? withErrors(basePrompt, lastErrors) : basePrompt;
  const r3 = await attemptPlan(args.callers.fallback, fbPrompt, ids, args.trip.dayCount);
  if ("plan" in r3) return { plan: r3.plan, usedFallback: true };
  throw new Error(`PLAN_GENERATION_FAILED: ${r3.errors.join("; ")}`);
}

export async function arrangeSwap(args: {
  trip: TripMeta;
  travelers: TravelerPrefs[];
  allowed: PlaceCandidate[];
  block: Block;
  dayIndex: number;
  callers: Callers;
}): Promise<{ swap: SwapBlock; usedFallback: boolean }> {
  const allowedIds = new Set(args.allowed.map((c) => c.placeId));
  const prompt = buildSwapPrompt(args);

  const attempt = async (caller: (p: string) => Promise<string>): Promise<SwapBlock | null> => {
    const text = await caller(prompt);
    try {
      const parsed = swapBlockSchema.safeParse(extractJson(text));
      if (parsed.success && allowedIds.has(parsed.data.candidateId)) return parsed.data;
    } catch {
      /* fall through */
    }
    return null;
  };

  try {
    const first = await attempt(args.callers.primary);
    if (first) return { swap: first, usedFallback: false };
  } catch {
    /* transport error — try fallback */
  }
  const second = await attempt(args.callers.fallback);
  if (second) return { swap: second, usedFallback: true };
  throw new Error("SWAP_GENERATION_FAILED: no valid venue produced");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/__tests__/generate.test.ts` — Expected: all passed. Then run the full suite: `npm test` — Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add lib && git commit -m "feat: grounded generation pipeline with validation, retry, fallback"
```

---

### Task 8: Database client and realtime broadcast (`lib/db.ts`, `lib/realtime.ts`)

**Files:**
- Create: `lib/db.ts`, `lib/realtime.ts`
- Test: `lib/__tests__/realtime.test.ts`

**Interfaces:**
- Produces:
  - `serviceClient(): SupabaseClient` — service-role Supabase client (server only).
  - `broadcastTripUpdate(slug: string, fetchImpl?: typeof fetch): Promise<void>` — POSTs to Supabase Realtime broadcast REST endpoint, topic `trip:{slug}`, event `updated`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { broadcastTripUpdate } from "@/lib/realtime";

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
});

describe("broadcastTripUpdate", () => {
  it("POSTs the trip topic to the realtime broadcast endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 202 })) as unknown as typeof fetch;
    await broadcastTripUpdate("x7Kf9qLmB2", fetchImpl);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://example.supabase.co/realtime/v1/api/broadcast");
    const body = JSON.parse(init.body as string);
    expect(body.messages[0]).toMatchObject({ topic: "trip:x7Kf9qLmB2", event: "updated" });
    expect((init.headers as Record<string, string>).apikey).toBe("service-key");
  });

  it("throws on non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await expect(broadcastTripUpdate("slug", fetchImpl)).rejects.toThrow("broadcast failed: 403");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/__tests__/realtime.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement both modules**

`lib/db.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function serviceClient(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}
```

`lib/realtime.ts`:

```ts
export async function broadcastTripUpdate(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const res = await fetchImpl(`${process.env.SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      messages: [{ topic: `trip:${slug}`, event: "updated", payload: {}, private: false }],
    }),
  });
  if (!res.ok) throw new Error(`broadcast failed: ${res.status}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/__tests__/realtime.test.ts` — Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add lib && git commit -m "feat: supabase service client and realtime broadcast helper"
```

---

### Task 9: API routes

**Files:**
- Create: `lib/auth.ts`
- Create: `app/api/trips/route.ts` (POST — create trip)
- Create: `app/api/trips/[slug]/route.ts` (GET — board data)
- Create: `app/api/trips/[slug]/join/route.ts` (POST)
- Create: `app/api/trips/[slug]/generate/route.ts` (POST)
- Create: `app/api/items/[id]/vote/route.ts` (POST)
- Create: `app/api/items/[id]/swap/route.ts` (POST)
- Create: `app/api/places/autocomplete/route.ts` (GET)
- Test: `app/api/__tests__/trips.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–8.
- Produces (consumed by the UI in Task 10):
  - `POST /api/trips` body `CreateTrip` → `201 { slug }`
  - `GET /api/trips/{slug}?token=...` → `200 { trip: { slug, destinationName, startDate, endDate, budgetLevel, vibeNote, lat, lng, dayCount }, me: { id, isOrganizer }, travelers: { id, displayName, interests, pace, dietary, isOrganizer }[], items: BoardItem[] }` where `BoardItem = { id, dayIndex, block, whyNote, durationMin, position, travelWarning, venue: { name, rating, reviewCount, priceLevel, openingHours, lat, lng, mapsUrl }, voteSum, myVote }`
  - `POST /api/trips/{slug}/join` body `JoinTrip` → `201 { token, travelerId }` (first joiner becomes organizer)
  - `POST /api/trips/{slug}/generate` body `{ token }` → `200 { usedFallback }` (organizer only; persists items; broadcasts)
  - `POST /api/items/{id}/vote` body `{ slug, token, value: 1|-1 }` → `200 {}` (toggles off when same value re-sent; broadcasts)
  - `POST /api/items/{id}/swap` body `{ slug, token }` → `200 { usedFallback }` (broadcasts)
  - `GET /api/places/autocomplete?q=...` → `200 { results: { placeId, name, address, lat, lng }[] }` (top 5)
- Error shape everywhere: `{ error: string }` with 400 (validation), 401 (bad token), 403 (not organizer), 404 (unknown slug/item), 500/502 (generation failure).

- [ ] **Step 1: Implement the shared auth helper `lib/auth.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type TripRow = {
  id: string; slug: string; destination_name: string; destination_place_id: string;
  lat: number; lng: number; start_date: string; end_date: string;
  budget_level: "low" | "mid" | "high"; vibe_note: string;
};

export type TravelerRow = {
  id: string; trip_id: string; display_name: string; token: string; interests: string[];
  pace: string; dietary: string; constraints_note: string; is_organizer: boolean;
};

export function dayCount(startDate: string, endDate: string): number {
  const ms = new Date(endDate).getTime() - new Date(startDate).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

/** Returns trip + authenticated traveler, or a typed error. */
export async function authTraveler(
  db: SupabaseClient,
  slug: string,
  token: string,
): Promise<{ trip: TripRow; me: TravelerRow } | { status: 404 | 401; error: string }> {
  const { data: trip } = await db.from("trips").select("*").eq("slug", slug).single();
  if (!trip) return { status: 404, error: "Trip not found" };
  const { data: me } = await db
    .from("travelers").select("*").eq("trip_id", trip.id).eq("token", token).single();
  if (!me) return { status: 401, error: "Invalid traveler token" };
  return { trip: trip as TripRow, me: me as TravelerRow };
}
```

- [ ] **Step 2: Write the failing route test**

`app/api/__tests__/trips.test.ts` — tests the create-trip route with a mocked db module:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const insertMock = vi.fn().mockResolvedValue({ error: null });
vi.mock("@/lib/db", () => ({
  serviceClient: () => ({ from: () => ({ insert: insertMock }) }),
}));

import { POST } from "@/app/api/trips/route";

beforeEach(() => insertMock.mockClear());

describe("POST /api/trips", () => {
  const valid = {
    destinationName: "Lisbon", destinationPlaceId: "ChIJ123", lat: 38.72, lng: -9.14,
    startDate: "2026-09-10", endDate: "2026-09-13", budgetLevel: "mid",
  };

  it("creates a trip and returns a 10-char slug", async () => {
    const res = await POST(new Request("http://test/api/trips", {
      method: "POST", body: JSON.stringify(valid),
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slug).toHaveLength(10);
    expect(insertMock).toHaveBeenCalledOnce();
  });

  it("rejects an invalid payload with 400", async () => {
    const res = await POST(new Request("http://test/api/trips", {
      method: "POST", body: JSON.stringify({ ...valid, endDate: "2026-09-01" }),
    }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/api/__tests__/trips.test.ts` — Expected: FAIL, route module not found.

- [ ] **Step 4: Implement the routes**

`app/api/trips/route.ts`:

```ts
import { NextResponse } from "next/server";
import { createTripSchema } from "@/lib/schema";
import { makeSlug } from "@/lib/ids";
import { serviceClient } from "@/lib/db";

export async function POST(req: Request): Promise<NextResponse> {
  const parsed = createTripSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }
  const t = parsed.data;
  const slug = makeSlug();
  const { error } = await serviceClient().from("trips").insert({
    slug,
    destination_name: t.destinationName,
    destination_place_id: t.destinationPlaceId,
    lat: t.lat,
    lng: t.lng,
    start_date: t.startDate,
    end_date: t.endDate,
    budget_level: t.budgetLevel,
    vibe_note: t.vibeNote,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ slug }, { status: 201 });
}
```

`app/api/trips/[slug]/join/route.ts`:

```ts
import { NextResponse } from "next/server";
import { joinTripSchema } from "@/lib/schema";
import { makeToken } from "@/lib/ids";
import { serviceClient } from "@/lib/db";
import { broadcastTripUpdate } from "@/lib/realtime";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const parsed = joinTripSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }
  const db = serviceClient();
  const { data: trip } = await db.from("trips").select("id").eq("slug", slug).single();
  if (!trip) return NextResponse.json({ error: "Trip not found" }, { status: 404 });

  const { count } = await db
    .from("travelers").select("id", { count: "exact", head: true }).eq("trip_id", trip.id);
  const token = makeToken();
  const { data: created, error } = await db
    .from("travelers")
    .insert({
      trip_id: trip.id,
      display_name: parsed.data.displayName,
      token,
      interests: parsed.data.interests,
      pace: parsed.data.pace,
      dietary: parsed.data.dietary,
      constraints_note: parsed.data.constraintsNote,
      is_organizer: (count ?? 0) === 0,
    })
    .select("id")
    .single();
  if (error || !created) return NextResponse.json({ error: error?.message ?? "join failed" }, { status: 500 });
  await broadcastTripUpdate(slug).catch(() => {});
  return NextResponse.json({ token, travelerId: created.id }, { status: 201 });
}
```

`app/api/trips/[slug]/route.ts` (GET board):

```ts
import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/db";
import { authTraveler, dayCount } from "@/lib/auth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const db = serviceClient();
  const auth = await authTraveler(db, slug, token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { trip, me } = auth;

  const { data: travelers } = await db
    .from("travelers")
    .select("id, display_name, interests, pace, dietary, is_organizer")
    .eq("trip_id", trip.id)
    .order("created_at");

  const { data: items } = await db
    .from("itinerary_items")
    .select("*, venue_candidates(name, rating, review_count, price_level, opening_hours, lat, lng, maps_url), votes(traveler_id, value)")
    .eq("trip_id", trip.id)
    .order("day_index")
    .order("position");

  type VoteRow = { traveler_id: string; value: number };
  return NextResponse.json({
    trip: {
      slug: trip.slug,
      destinationName: trip.destination_name,
      startDate: trip.start_date,
      endDate: trip.end_date,
      budgetLevel: trip.budget_level,
      vibeNote: trip.vibe_note,
      lat: trip.lat,
      lng: trip.lng,
      dayCount: dayCount(trip.start_date, trip.end_date),
    },
    me: { id: me.id, isOrganizer: me.is_organizer },
    travelers: (travelers ?? []).map((t) => ({
      id: t.id, displayName: t.display_name, interests: t.interests,
      pace: t.pace, dietary: t.dietary, isOrganizer: t.is_organizer,
    })),
    items: (items ?? []).map((i) => {
      const votes = (i.votes ?? []) as VoteRow[];
      const v = i.venue_candidates as {
        name: string; rating: number | null; review_count: number; price_level: string | null;
        opening_hours: string[]; lat: number; lng: number; maps_url: string;
      };
      return {
        id: i.id, dayIndex: i.day_index, block: i.block, whyNote: i.why_note,
        durationMin: i.duration_min, position: i.position, travelWarning: i.travel_warning,
        venue: {
          name: v.name, rating: v.rating, reviewCount: v.review_count, priceLevel: v.price_level,
          openingHours: v.opening_hours, lat: v.lat, lng: v.lng, mapsUrl: v.maps_url,
        },
        voteSum: votes.reduce((s, x) => s + x.value, 0),
        myVote: votes.find((x) => x.traveler_id === me.id)?.value ?? 0,
      };
    }),
  });
}
```

`app/api/trips/[slug]/generate/route.ts`:

```ts
import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/db";
import { authTraveler, dayCount, type TravelerRow } from "@/lib/auth";
import { buildCategoryQueries, searchPlaces, filterByRating, type PlaceCandidate } from "@/lib/places";
import { getCallers } from "@/lib/llm";
import { arrangePlan, travelWarnings } from "@/lib/generate";
import { broadcastTripUpdate } from "@/lib/realtime";
import type { TravelerPrefs } from "@/lib/schema";

export const maxDuration = 300; // generation: Places + up to 3 LLM attempts

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const db = serviceClient();
  const auth = await authTraveler(db, slug, body.token ?? "");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { trip, me } = auth;
  if (!me.is_organizer) {
    return NextResponse.json({ error: "Only the organizer can generate the plan" }, { status: 403 });
  }

  const { data: travelerRows } = await db.from("travelers").select("*").eq("trip_id", trip.id);
  const travelers: TravelerPrefs[] = ((travelerRows ?? []) as TravelerRow[]).map((t) => ({
    displayName: t.display_name, interests: t.interests, pace: t.pace,
    dietary: t.dietary, constraintsNote: t.constraints_note,
  }));

  // 1) Candidates: reuse cache if present, else retrieve from Places and persist.
  let { data: candRows } = await db.from("venue_candidates").select("*").eq("trip_id", trip.id);
  if (!candRows || candRows.length === 0) {
    const queries = buildCategoryQueries(
      travelers.flatMap((t) => t.interests),
      travelers.map((t) => t.dietary),
    );
    const apiKey = process.env.GOOGLE_MAPS_API_KEY!;
    let fetched: PlaceCandidate[] = [];
    try {
      for (const q of queries) {
        const results = await searchPlaces({ query: `${q.query} in ${trip.destination_name}`, category: q.category, lat: trip.lat, lng: trip.lng, apiKey });
        fetched = fetched.concat(filterByRating(results));
      }
    } catch (e) {
      return NextResponse.json({ error: `Venue lookup failed: ${(e as Error).message}` }, { status: 502 });
    }
    // dedupe by google place id
    const seen = new Set<string>();
    const unique = fetched.filter((c) => (seen.has(c.placeId) ? false : (seen.add(c.placeId), true)));
    const { error: insertErr } = await db.from("venue_candidates").upsert(
      unique.map((c) => ({
        trip_id: trip.id, place_id: c.placeId, name: c.name, category: c.category,
        rating: c.rating, review_count: c.reviewCount, price_level: c.priceLevel,
        opening_hours: c.openingHours, lat: c.lat, lng: c.lng, maps_url: c.mapsUrl,
      })),
      { onConflict: "trip_id,place_id" },
    );
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
    ({ data: candRows } = await db.from("venue_candidates").select("*").eq("trip_id", trip.id));
  }
  if (!candRows || candRows.length < 8) {
    return NextResponse.json({ error: "Not enough venues found for this destination" }, { status: 502 });
  }

  // 2) Arrange. candidateId given to the LLM = venue_candidates.id (row uuid).
  const candidates: PlaceCandidate[] = candRows.map((r) => ({
    placeId: r.id, name: r.name, category: r.category, rating: r.rating,
    reviewCount: r.review_count, priceLevel: r.price_level,
    openingHours: (r.opening_hours ?? []) as string[], lat: r.lat, lng: r.lng, mapsUrl: r.maps_url,
  }));
  const tripMeta = {
    destinationName: trip.destination_name, startDate: trip.start_date, endDate: trip.end_date,
    budgetLevel: trip.budget_level, vibeNote: trip.vibe_note,
    dayCount: dayCount(trip.start_date, trip.end_date),
  };
  let plan, usedFallback;
  try {
    ({ plan, usedFallback } = await arrangePlan({ trip: tripMeta, travelers, candidates, callers: getCallers() }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  // 3) Persist: replace previous items, flag travel warnings.
  const byId = new Map(candidates.map((c) => [c.placeId, c]));
  const warned = travelWarnings(plan, byId);
  await db.from("itinerary_items").delete().eq("trip_id", trip.id);
  const rows = plan.days.flatMap((day) =>
    day.blocks.map((b, i) => ({
      trip_id: trip.id, day_index: day.dayIndex, block: b.block, candidate_id: b.candidateId,
      why_note: b.whyNote, duration_min: b.durationMin, position: i,
      travel_warning: warned.has(b.candidateId),
    })),
  );
  const { error: itemsErr } = await db.from("itinerary_items").insert(rows);
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });

  await broadcastTripUpdate(slug).catch(() => {});
  return NextResponse.json({ usedFallback });
}
```

`app/api/items/[id]/vote/route.ts`:

```ts
import { NextResponse } from "next/server";
import { voteSchema } from "@/lib/schema";
import { serviceClient } from "@/lib/db";
import { authTraveler } from "@/lib/auth";
import { broadcastTripUpdate } from "@/lib/realtime";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = voteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  const { slug, token, value } = parsed.data;

  const db = serviceClient();
  const auth = await authTraveler(db, slug, token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { trip, me } = auth;

  const { data: item } = await db
    .from("itinerary_items").select("id").eq("id", id).eq("trip_id", trip.id).single();
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  const { data: existing } = await db
    .from("votes").select("id, value").eq("item_id", id).eq("traveler_id", me.id).maybeSingle();
  if (existing && existing.value === value) {
    await db.from("votes").delete().eq("id", existing.id); // toggle off
  } else {
    await db.from("votes").upsert(
      { item_id: id, traveler_id: me.id, value },
      { onConflict: "item_id,traveler_id" },
    );
  }
  await broadcastTripUpdate(slug).catch(() => {});
  return NextResponse.json({});
}
```

`app/api/items/[id]/swap/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/db";
import { authTraveler, dayCount, type TravelerRow } from "@/lib/auth";
import { getCallers } from "@/lib/llm";
import { arrangeSwap } from "@/lib/generate";
import { broadcastTripUpdate } from "@/lib/realtime";
import type { PlaceCandidate } from "@/lib/places";
import type { Block, TravelerPrefs } from "@/lib/schema";

export const maxDuration = 180;

const swapReqSchema = z.object({ slug: z.string().min(1), token: z.string().min(1) });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = swapReqSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const db = serviceClient();
  const auth = await authTraveler(db, parsed.data.slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { trip } = auth;

  const { data: item } = await db
    .from("itinerary_items").select("*").eq("id", id).eq("trip_id", trip.id).single();
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  const [{ data: travelerRows }, { data: candRows }, { data: usedRows }] = await Promise.all([
    db.from("travelers").select("*").eq("trip_id", trip.id),
    db.from("venue_candidates").select("*").eq("trip_id", trip.id),
    db.from("itinerary_items").select("candidate_id").eq("trip_id", trip.id),
  ]);
  const usedIds = new Set((usedRows ?? []).map((r) => r.candidate_id as string));
  const allowed: PlaceCandidate[] = (candRows ?? [])
    .filter((r) => !usedIds.has(r.id))
    .map((r) => ({
      placeId: r.id, name: r.name, category: r.category, rating: r.rating,
      reviewCount: r.review_count, priceLevel: r.price_level,
      openingHours: (r.opening_hours ?? []) as string[], lat: r.lat, lng: r.lng, mapsUrl: r.maps_url,
    }));
  if (allowed.length === 0) {
    return NextResponse.json({ error: "No alternative venues left to swap in" }, { status: 502 });
  }

  const travelers: TravelerPrefs[] = ((travelerRows ?? []) as TravelerRow[]).map((t) => ({
    displayName: t.display_name, interests: t.interests, pace: t.pace,
    dietary: t.dietary, constraintsNote: t.constraints_note,
  }));

  try {
    const { swap, usedFallback } = await arrangeSwap({
      trip: {
        destinationName: trip.destination_name, startDate: trip.start_date, endDate: trip.end_date,
        budgetLevel: trip.budget_level, vibeNote: trip.vibe_note,
        dayCount: dayCount(trip.start_date, trip.end_date),
      },
      travelers,
      allowed,
      block: item.block as Block,
      dayIndex: item.day_index,
      callers: getCallers(),
    });
    await db.from("itinerary_items").update({
      candidate_id: swap.candidateId, why_note: swap.whyNote, duration_min: swap.durationMin,
    }).eq("id", id);
    await broadcastTripUpdate(parsed.data.slug).catch(() => {});
    return NextResponse.json({ usedFallback });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
```

`app/api/places/autocomplete/route.ts`:

```ts
import { NextResponse } from "next/server";

export async function GET(req: Request): Promise<NextResponse> {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ results: [] });
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY!,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
    },
    body: JSON.stringify({ textQuery: q, pageSize: 5 }),
  });
  if (!res.ok) return NextResponse.json({ error: "Places lookup failed" }, { status: 502 });
  const data = (await res.json()) as {
    places?: { id: string; displayName?: { text?: string }; formattedAddress?: string; location?: { latitude?: number; longitude?: number } }[];
  };
  return NextResponse.json({
    results: (data.places ?? []).map((p) => ({
      placeId: p.id,
      name: p.displayName?.text ?? "",
      address: p.formattedAddress ?? "",
      lat: p.location?.latitude ?? 0,
      lng: p.location?.longitude ?? 0,
    })),
  });
}
```

- [ ] **Step 5: Run tests and type-check**

```bash
npx vitest run app/api/__tests__/trips.test.ts   # Expected: 2 passed
npm test                                          # Expected: full suite green
npx tsc --noEmit                                  # Expected: no errors
```

- [ ] **Step 6: Commit**

```bash
git add app lib && git commit -m "feat: API routes for trips, join, generate, vote, swap, autocomplete"
```

---

### Task 10: UI — create page, join form, live board, map

**Files:**
- Create: `components/CreateTripForm.tsx`, `components/JoinForm.tsx`, `components/TripBoard.tsx`, `components/DayMap.tsx`, `lib/supabase-browser.ts`
- Modify: `app/page.tsx`
- Create: `app/t/[slug]/page.tsx`

**Interfaces:**
- Consumes: all API routes from Task 9 (exact shapes listed there).
- Produces: the two user-facing pages. Traveler token stored in `localStorage` under key `tp:{slug}`.

- [ ] **Step 1: Browser Supabase client `lib/supabase-browser.ts`**

```ts
"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function browserClient(): SupabaseClient {
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return client;
}
```

- [ ] **Step 2: `components/CreateTripForm.tsx`**

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Suggestion = { placeId: string; name: string; address: string; lat: number; lng: number };

export default function CreateTripForm() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [budgetLevel, setBudgetLevel] = useState<"low" | "mid" | "high">("mid");
  const [vibeNote, setVibeNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function search(q: string) {
    setQuery(q);
    setSelected(null);
    if (q.trim().length < 2) return setSuggestions([]);
    const res = await fetch(`/api/places/autocomplete?q=${encodeURIComponent(q)}`);
    if (res.ok) setSuggestions((await res.json()).results);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return setError("Pick a destination from the suggestions");
    setBusy(true);
    setError("");
    const res = await fetch("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destinationName: selected.name,
        destinationPlaceId: selected.placeId,
        lat: selected.lat,
        lng: selected.lng,
        startDate,
        endDate,
        budgetLevel,
        vibeNote,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      setBusy(false);
      return setError(body.error ?? "Something went wrong");
    }
    router.push(`/t/${body.slug}`);
  }

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">Plan a trip together</h1>
      <div className="relative">
        <input
          className="w-full rounded border p-2"
          placeholder="Where are you going?"
          value={selected ? selected.name : query}
          onChange={(e) => search(e.target.value)}
          required
        />
        {suggestions.length > 0 && !selected && (
          <ul className="absolute z-10 w-full rounded border bg-white shadow">
            {suggestions.map((s) => (
              <li key={s.placeId}>
                <button
                  type="button"
                  className="block w-full p-2 text-left hover:bg-gray-100"
                  onClick={() => {
                    setSelected(s);
                    setSuggestions([]);
                  }}
                >
                  {s.name} <span className="text-sm text-gray-500">{s.address}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex gap-2">
        <label className="flex-1">
          From
          <input type="date" className="w-full rounded border p-2" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
        </label>
        <label className="flex-1">
          To
          <input type="date" className="w-full rounded border p-2" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
        </label>
      </div>
      <label>
        Budget
        <select className="w-full rounded border p-2" value={budgetLevel} onChange={(e) => setBudgetLevel(e.target.value as "low" | "mid" | "high")}>
          <option value="low">€ — keep it cheap</option>
          <option value="mid">€€ — comfortable</option>
          <option value="high">€€€ — treat ourselves</option>
        </select>
      </label>
      <label>
        Trip vibe (optional)
        <textarea className="w-full rounded border p-2" value={vibeNote} onChange={(e) => setVibeNote(e.target.value)} placeholder="e.g. relaxed foodie trip, no early mornings" />
      </label>
      {error && <p className="text-red-600">{error}</p>}
      <button className="rounded bg-blue-600 p-2 font-semibold text-white disabled:opacity-50" disabled={busy}>
        {busy ? "Creating…" : "Create trip"}
      </button>
    </form>
  );
}
```

- [ ] **Step 3: `app/page.tsx`**

```tsx
import CreateTripForm from "@/components/CreateTripForm";

export default function Home() {
  return <CreateTripForm />;
}
```

- [ ] **Step 4: `components/JoinForm.tsx`**

```tsx
"use client";
import { useState } from "react";
import { INTERESTS } from "@/lib/schema";

const INTEREST_LABELS: Record<string, string> = {
  food: "Food & markets", history: "History & museums", nature: "Nature & parks",
  nightlife: "Nightlife", shopping: "Shopping", art: "Art & culture",
  water: "Beaches & water", active: "Sports & active",
};

export default function JoinForm({ slug, onJoined }: { slug: string; onJoined: (token: string) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [interests, setInterests] = useState<string[]>([]);
  const [pace, setPace] = useState("balanced");
  const [dietary, setDietary] = useState("none");
  const [constraintsNote, setConstraintsNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function toggleInterest(i: string) {
    setInterests((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch(`/api/trips/${slug}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName, interests, pace, dietary, constraintsNote }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) return setError(body.error ?? "Could not join");
    localStorage.setItem(`tp:${slug}`, body.token);
    onJoined(body.token);
  }

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">Join this trip</h1>
      <input className="rounded border p-2" placeholder="Your name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
      <fieldset>
        <legend className="font-semibold">What do you enjoy?</legend>
        <div className="grid grid-cols-2 gap-1">
          {INTERESTS.map((i) => (
            <label key={i} className="flex items-center gap-2">
              <input type="checkbox" checked={interests.includes(i)} onChange={() => toggleInterest(i)} />
              {INTEREST_LABELS[i]}
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        Pace
        <select className="w-full rounded border p-2" value={pace} onChange={(e) => setPace(e.target.value)}>
          <option value="chill">Chill</option>
          <option value="balanced">Balanced</option>
          <option value="packed">Packed</option>
        </select>
      </label>
      <label>
        Dietary
        <select className="w-full rounded border p-2" value={dietary} onChange={(e) => setDietary(e.target.value)}>
          <option value="none">No restrictions</option>
          <option value="vegetarian">Vegetarian</option>
          <option value="vegan">Vegan</option>
          <option value="halal">Halal</option>
          <option value="other">Other (mention below)</option>
        </select>
      </label>
      <textarea className="rounded border p-2" placeholder="Anything else? (toddler, no early mornings, limited walking…)" value={constraintsNote} onChange={(e) => setConstraintsNote(e.target.value)} />
      {error && <p className="text-red-600">{error}</p>}
      <button className="rounded bg-blue-600 p-2 font-semibold text-white disabled:opacity-50" disabled={busy || interests.length === 0}>
        {busy ? "Joining…" : "Join trip"}
      </button>
      {interests.length === 0 && <p className="text-sm text-gray-500">Pick at least one interest.</p>}
    </form>
  );
}
```

- [ ] **Step 5: `components/DayMap.tsx`**

```tsx
"use client";
import { useEffect, useRef } from "react";
import { Loader } from "@googlemaps/js-api-loader";

export type MapPin = { lat: number; lng: number; label: string };

export default function DayMap({ center, pins }: { center: { lat: number; lng: number }; pins: MapPin[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
    if (!key || !ref.current) return;
    const loader = new Loader({ apiKey: key });
    let cancelled = false;
    loader.importLibrary("maps").then(({ Map }) => {
      if (cancelled || !ref.current) return;
      const map = new Map(ref.current, { center, zoom: 13, mapId: "trip-board" });
      const bounds = new google.maps.LatLngBounds();
      pins.forEach((p, i) => {
        new google.maps.Marker({ position: p, map, label: `${i + 1}`, title: p.label });
        bounds.extend(p);
      });
      if (pins.length > 1) map.fitBounds(bounds, 48);
    });
    return () => {
      cancelled = true;
    };
  }, [center, pins]);

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY) return null;
  return <div ref={ref} className="h-72 w-full rounded border" />;
}
```

- [ ] **Step 6: `components/TripBoard.tsx`**

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase-browser";
import JoinForm from "@/components/JoinForm";
import DayMap from "@/components/DayMap";

type Venue = {
  name: string; rating: number | null; reviewCount: number; priceLevel: string | null;
  openingHours: string[]; lat: number; lng: number; mapsUrl: string;
};
type BoardItem = {
  id: string; dayIndex: number; block: string; whyNote: string; durationMin: number;
  position: number; travelWarning: boolean; venue: Venue; voteSum: number; myVote: number;
};
type Board = {
  trip: { slug: string; destinationName: string; startDate: string; endDate: string; dayCount: number; lat: number; lng: number };
  me: { id: string; isOrganizer: boolean };
  travelers: { id: string; displayName: string; isOrganizer: boolean }[];
  items: BoardItem[];
};

const BLOCK_ORDER = ["morning", "lunch", "afternoon", "dinner", "evening"];

export default function TripBoard({ slug }: { slug: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [day, setDay] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setToken(localStorage.getItem(`tp:${slug}`));
    setReady(true);
  }, [slug]);

  const refetch = useCallback(async () => {
    if (!token) return;
    const res = await fetch(`/api/trips/${slug}?token=${token}`);
    if (res.status === 401) {
      localStorage.removeItem(`tp:${slug}`);
      setToken(null);
      return;
    }
    if (res.ok) setBoard(await res.json());
  }, [slug, token]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (!token) return;
    const channel = browserClient()
      .channel(`trip:${slug}`)
      .on("broadcast", { event: "updated" }, () => refetch())
      .subscribe();
    return () => {
      channel.unsubscribe();
    };
  }, [slug, token, refetch]);

  async function generate() {
    setBusy("generate");
    setError("");
    const res = await fetch(`/api/trips/${slug}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    setBusy("");
    if (!res.ok) setError((await res.json()).error ?? "Generation failed");
    else refetch();
  }

  async function vote(itemId: string, value: 1 | -1) {
    await fetch(`/api/items/${itemId}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, token, value }),
    });
    refetch();
  }

  async function swap(itemId: string) {
    setBusy(itemId);
    setError("");
    const res = await fetch(`/api/items/${itemId}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, token }),
    });
    setBusy("");
    if (!res.ok) setError((await res.json()).error ?? "Swap failed");
    else refetch();
  }

  if (!ready) return null;
  if (!token) return <JoinForm slug={slug} onJoined={setToken} />;
  if (!board) return <p className="p-6">Loading trip…</p>;

  const dayItems = board.items
    .filter((i) => i.dayIndex === day)
    .sort((a, b) => BLOCK_ORDER.indexOf(a.block) - BLOCK_ORDER.indexOf(b.block));

  return (
    <div className="mx-auto max-w-3xl p-4">
      <header className="mb-4">
        <h1 className="text-2xl font-bold">{board.trip.destinationName}</h1>
        <p className="text-gray-600">
          {board.trip.startDate} → {board.trip.endDate} · {board.travelers.map((t) => t.displayName).join(", ")}
        </p>
        <p className="text-sm text-gray-400">Anyone with this link can join and edit.</p>
      </header>

      {board.items.length === 0 ? (
        <div className="rounded border p-6 text-center">
          <p className="mb-4">No plan yet.</p>
          {board.me.isOrganizer ? (
            <button onClick={generate} disabled={busy === "generate"} className="rounded bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-50">
              {busy === "generate" ? "Generating… (can take a minute)" : "✨ Generate plan"}
            </button>
          ) : (
            <p className="text-gray-500">Waiting for the organizer to generate the plan.</p>
          )}
        </div>
      ) : (
        <>
          <nav className="mb-4 flex gap-2 overflow-x-auto">
            {Array.from({ length: board.trip.dayCount }, (_, i) => (
              <button key={i} onClick={() => setDay(i)} className={`rounded px-3 py-1 ${i === day ? "bg-blue-600 text-white" : "bg-gray-100"}`}>
                Day {i + 1}
              </button>
            ))}
            {board.me.isOrganizer && (
              <button onClick={generate} disabled={busy === "generate"} className="ml-auto rounded bg-gray-100 px-3 py-1 disabled:opacity-50" title="Regenerate the whole plan">
                {busy === "generate" ? "Regenerating…" : "↻ Regenerate"}
              </button>
            )}
          </nav>

          <DayMap
            center={{ lat: board.trip.lat, lng: board.trip.lng }}
            pins={dayItems.map((i) => ({ lat: i.venue.lat, lng: i.venue.lng, label: i.venue.name }))}
          />

          <ul className="mt-4 flex flex-col gap-3">
            {dayItems.map((item) => (
              <li key={item.id} className="rounded border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="text-xs font-semibold uppercase text-gray-400">{item.block}</span>
                    <h3 className="font-semibold">
                      <a href={item.venue.mapsUrl} target="_blank" rel="noreferrer" className="hover:underline">
                        {item.venue.name} ↗
                      </a>
                    </h3>
                    <p className="text-sm text-gray-600">
                      {item.venue.rating ? `★ ${item.venue.rating} (${item.venue.reviewCount})` : "unrated"} · ~{item.durationMin} min
                      {item.travelWarning && <span className="ml-2 rounded bg-amber-100 px-1 text-amber-800">⚠ far from previous stop</span>}
                    </p>
                    <p className="text-sm">{item.whyNote}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex gap-1">
                      <button onClick={() => vote(item.id, 1)} className={`rounded px-2 py-1 ${item.myVote === 1 ? "bg-green-200" : "bg-gray-100"}`}>👍</button>
                      <button onClick={() => vote(item.id, -1)} className={`rounded px-2 py-1 ${item.myVote === -1 ? "bg-red-200" : "bg-gray-100"}`}>👎</button>
                    </div>
                    <span className="text-sm text-gray-500">{item.voteSum > 0 ? `+${item.voteSum}` : item.voteSum}</span>
                    <button onClick={() => swap(item.id)} disabled={busy === item.id} className="rounded bg-gray-100 px-2 py-1 text-sm disabled:opacity-50">
                      {busy === item.id ? "Swapping…" : "Swap"}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="mt-4 text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 7: `app/t/[slug]/page.tsx`**

```tsx
import TripBoard from "@/components/TripBoard";

export default async function TripPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <TripBoard slug={slug} />;
}
```

- [ ] **Step 8: Verify locally**

```bash
cp .env.example .env.local   # then fill in real values
npm run dev
```
Manual checks at `http://localhost:3000`:
1. Create a trip (autocomplete suggests real destinations) → redirected to `/t/{slug}`.
2. Join as "Alice" → board shows "No plan yet" with Generate button (organizer).
3. Open the same URL in a private window, join as "Bob" → sees "Waiting for the organizer".
4. As Alice, Generate → plan appears with real venues; Bob's window updates **without refresh** (broadcast).
5. Vote and swap from Bob's window → Alice's window updates live.
6. `npx tsc --noEmit` and `npm run build` — Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add app components lib && git commit -m "feat: create trip, join, live board UI with map and votes"
```

---

### Task 11: Deployment and end-to-end verification

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the complete app.
- Produces: a live Vercel deployment usable by friends & family.

- [ ] **Step 1: External services checklist (manual)**

1. **Google Cloud** (console.cloud.google.com): create project `trip-planner`; enable **Places API (New)** and **Maps JavaScript API**; attach billing card (stays within $200/mo free credit at family scale). Create two API keys:
   - Server key → restrict to Places API (New) → `GOOGLE_MAPS_API_KEY`
   - Browser key → restrict to Maps JavaScript API + HTTP referrers (`localhost:3000/*`, your Vercel domain) → `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`
2. **Supabase**: project `trip-planner` created in Task 2. Copy Project URL → `SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_URL`; anon key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`; service role key → `SUPABASE_SERVICE_ROLE_KEY`.
3. **Ollama Cloud**: create an API key at ollama.com → `OLLAMA_API_KEY` (existing $20/mo subscription).
4. **Anthropic**: create an API key at platform.claude.com with a low monthly spend cap (e.g. $5) → `ANTHROPIC_API_KEY` (fallback only).

- [ ] **Step 2: Write `README.md`**

Contents: one-paragraph description, local dev instructions (`cp .env.example .env.local`, fill values, `npm run dev`), env var table (copy from `.env.example` with one-line descriptions), deploy instructions (below), and a note that the trip link is the only secret ("anyone with the link can join").

- [ ] **Step 3: Deploy to Vercel**

```bash
npx vercel link          # create project "trip-planner"
# Add every var from .env.example to Vercel (Production):
npx vercel env add LLM_PROVIDER production        # ... repeat for each var
npx vercel --prod
```
Then update the Google **browser key** referrer restriction with the production domain.

- [ ] **Step 4: Production E2E check**

On the production URL, repeat the 5 manual checks from Task 10 Step 8 with a real trip (e.g. Lisbon, 3 days, 2 travelers, one vegetarian). Verify:
- Every generated venue exists in Google Maps (click each ↗ link).
- Lunch/dinner picks are vegetarian-friendly.
- Generation completes in < 2 minutes.
- **Fallback drill:** temporarily set `OLLAMA_API_KEY` to an invalid value in Vercel, regenerate → plan still generates (Sonnet 5 fallback, response `usedFallback: true` in the network tab), then restore the key.

- [ ] **Step 5: Model quality check (spec §9)**

Generate the same trip twice: once with `LLM_PROVIDER=ollama` (GLM 5.2), once with `LLM_PROVIDER=anthropic` (Sonnet 5). Compare plan quality by eye — coherent days, hours respected, preferences balanced. Record the verdict in the README ("Model notes" section) so the default is a documented decision.

- [ ] **Step 6: Commit and tag**

```bash
git add README.md && git commit -m "docs: README with setup and deployment"
git tag v0.1.0
```
