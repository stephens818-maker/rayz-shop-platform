import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RatingViewer,
  cleanRating,
  deleteRatingDenied,
  editRatingDenied,
  parseClientSort,
  parseRatingFilter,
  rateVisitDenied,
  ratingTone,
  seesAllRatings,
  splitLowHigh,
} from "@/domain/ratings";
import { toCsv } from "@/server/reports";

const CORALVILLE = "11111111-1111-1111-1111-111111111111";
const MOLINE = "22222222-2222-2222-2222-222222222222";
const admin: RatingViewer = { staffId: "owner", shopIds: [CORALVILLE, MOLINE], canRate: true, seesAll: true, moderates: true };
const manager: RatingViewer = { staffId: "michelle", shopIds: [CORALVILLE], canRate: true, seesAll: true, moderates: false };
const barber: RatingViewer = { staffId: "makenna", shopIds: [CORALVILLE], canRate: true, seesAll: false, moderates: false };
const otherBarber: RatingViewer = { staffId: "olivia", shopIds: [CORALVILLE], canRate: true, seesAll: false, moderates: false };

describe("client ratings: input", () => {
  it("accepts 1 to 5 whole stars and trims the note", () => {
    expect(cleanRating({ stars: 4, note: "  great tipper " })).toEqual({ stars: 4, note: "great tipper" });
    expect(cleanRating({ stars: 1 })).toEqual({ stars: 1, note: null });
    expect(cleanRating({ stars: 5, note: "   " })).toEqual({ stars: 5, note: null });
    expect(cleanRating({ stars: "3" })).toEqual({ stars: 3, note: null });
  });

  it("refuses anything else", () => {
    for (const stars of [0, 6, 2.5, -1, "x", "", " ", "2.5", "0x3", true, [4], null, undefined]) expect(cleanRating({ stars })).toHaveProperty("error");
    expect(cleanRating({ stars: 3, note: "x".repeat(501) })).toHaveProperty("error");
  });
});

describe("client ratings: who may do what", () => {
  const coralvilleVisit = { shopId: CORALVILLE, servedBy: ["makenna", null] };

  it("the barber who served the visit, a manager of that shop, and the brand admin can rate it", () => {
    expect(rateVisitDenied(barber, coralvilleVisit)).toBeNull();
    expect(rateVisitDenied(manager, coralvilleVisit)).toBeNull();
    expect(rateVisitDenied(admin, coralvilleVisit)).toBeNull();
  });

  it("another barber at the same shop and a manager of another shop can't", () => {
    expect(rateVisitDenied(otherBarber, coralvilleVisit)).toMatch(/you served/);
    expect(rateVisitDenied({ ...manager, shopIds: [MOLINE] }, coralvilleVisit)).toMatch(/outside your access/);
  });

  it("everyone edits only their own rating, including managers and the brand admin", () => {
    const barbersRating = { staffId: "makenna" };
    expect(editRatingDenied(barber, barbersRating)).toBeNull();
    expect(editRatingDenied(otherBarber, barbersRating)).not.toBeNull();
    expect(editRatingDenied(manager, barbersRating)).not.toBeNull();
    expect(editRatingDenied(admin, barbersRating)).not.toBeNull();
  });

  it("the author or a moderator can remove a rating; a manager without moderation can't remove a barber's", () => {
    const barbersRating = { staffId: "makenna", shopId: CORALVILLE };
    expect(deleteRatingDenied(barber, barbersRating)).toBeNull();
    expect(deleteRatingDenied(admin, barbersRating)).toBeNull();
    expect(deleteRatingDenied(manager, barbersRating)).not.toBeNull();
    expect(deleteRatingDenied(otherBarber, barbersRating)).not.toBeNull();
    expect(deleteRatingDenied({ ...admin, shopIds: [MOLINE] }, barbersRating)).not.toBeNull();
  });

  it("rating needs clients.rate", () => {
    expect(rateVisitDenied({ ...manager, canRate: false }, { shopId: CORALVILLE, servedBy: [] })).toMatch(/permission/);
  });

  it("managers and the admin read every rating; barbers don't", () => {
    expect(seesAllRatings(admin)).toBe(true);
    expect(seesAllRatings(manager)).toBe(true);
    expect(seesAllRatings(barber)).toBe(false);
  });
});

describe("client ratings: display, filters, and the report split", () => {
  it("colors the badge by average", () => {
    expect(ratingTone(2.9)).toBe("red");
    expect(ratingTone(3)).toBe("amber");
    expect(ratingTone(4)).toBe("green");
  });

  it("parses list filters and sorts, ignoring unknown values", () => {
    expect(parseRatingFilter("low")).toBe("low");
    expect(parseRatingFilter("drop table")).toBeNull();
    expect(parseClientSort("rating_asc")).toBe("rating_asc");
    expect(parseClientSort(undefined)).toBe("recent");
  });

  it("never puts the same client in both the lowest and highest lists", () => {
    expect(splitLowHigh(0, 10)).toEqual({ lowest: 0, highest: 0 });
    expect(splitLowHigh(1, 10)).toEqual({ lowest: 1, highest: 0 });
    expect(splitLowHigh(3, 10)).toEqual({ lowest: 2, highest: 1 });
    expect(splitLowHigh(25, 10)).toEqual({ lowest: 10, highest: 10 });
    for (let n = 0; n < 40; n++) {
      const s = splitLowHigh(n, 10);
      expect(s.lowest + s.highest).toBeLessThanOrEqual(n);
    }
  });

  it("CSV exports neutralize notes that look like spreadsheet formulas, and leave numbers alone", () => {
    const csv = toCsv(["Note", "Amount"], [["=HYPERLINK(\"x\")", "-10.00"], ["@SUM(A1)", -5], ["+1 great tipper", "3.50"]]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(",-10.00");
    expect(csv).toContain("'@SUM(A1),-5");
    expect(csv).toContain("'+1 great tipper,3.50");
  });
});

// ───────────── Static guard: the customer-facing code can't reach ratings ─────────────

const ROOT = resolve(__dirname, "..");
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/** Every source file reachable from the customer-facing entry points. */
function reachable(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    // `import type` and `export type … from` are erased when compiled, so they load nothing.
    const text = readFileSync(f, "utf8").replace(/^\s*(?:import|export)\s+type\s[^;]*?from\s+["'][^"']+["'];?/gm, "");
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
      const r = resolveImport(f, m[1]);
      if (r) queue.push(r);
    }
  }
  return seen;
}

describe("client ratings never reach customers", () => {
  const entries = [...walk(join(SRC, "app", "api")), ...walk(join(SRC, "app", "(public)")), join(SRC, "lib", "api-client.ts")];
  const files = reachable(entries);
  const rel = (f: string) => relative(ROOT, f);

  it("finds the public site and the API (sanity check for the walker)", () => {
    expect(files.has(join(SRC, "server", "public.ts"))).toBe(true);
    expect(files.has(join(SRC, "server", "booking.ts"))).toBe(true);
    expect(files.size).toBeGreaterThan(40);
  });

  it("no public page, API route, or anything they import loads the ratings service or the staff app", () => {
    const bad = [...files].map(rel).filter((f) => f === "src/server/ratings.ts" || f.startsWith("src/app/admin/"));
    expect(bad).toEqual([]);
  });

  it("the ratings table is only mentioned where it's defined and where a merge moves it", () => {
    const mentions = [...files].filter((f) => /clientRatings|client_ratings/.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(mentions.filter((f) => f !== "src/domain/permissions.ts")).toEqual(["src/db/schema.ts", "src/server/client-filters.ts", "src/server/customers.ts", "src/server/report-builder/engine.ts"]);
    // Client list filters and marketing segments (run by the marketing cron) filter on a client's average rating; the stars are never selected.
    const segment = readFileSync(join(SRC, "server", "client-filters.ts"), "utf8").split("\n").filter((l) => /clientRatings|client_ratings/.test(l));
    expect(segment).toEqual(["    const avg = sql`(select avg(r.stars) from client_ratings r where r.customer_id = c.id)`;"]);
    // Custom reports (emailed by the notifications cron) run under a staff member's Client data policy: the average
    // rating is a column only when that policy shows ratings, and it never goes to a client.
    const reports = readFileSync(join(SRC, "server", "report-builder", "engine.ts"), "utf8").split("\n").filter((l) => /clientRatings|client_ratings/.test(l));
    expect(reports).toEqual(["    rt: sql`rt as (select customer_id, avg(stars)::float8 avg from client_ratings group by customer_id)`,"]);
    // The permission catalog (reached by the cron's Morning Dashboard) names the ratings report, not the table.
    const catalog = readFileSync(join(SRC, "domain", "permissions.ts"), "utf8").split("\n").filter((l) => /clientRatings|client_ratings/.test(l));
    expect(catalog).toEqual([`  { key: "client_ratings", label: "Client ratings", href: "/admin/reports/ratings" },`]);
    const customers = readFileSync(join(SRC, "server", "customers.ts"), "utf8");
    const uses = customers.split("\n").filter((l) => /clientRatings/.test(l) && !/^\s*clientRatings,$/.test(l));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/tx\.update\(clientRatings\)\.set\(\{ customerId: keepId \}\)/);
  });
});
