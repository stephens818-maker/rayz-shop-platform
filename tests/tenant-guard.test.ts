import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hasShop, narrowShops } from "@/server/tenant";

const ADMIN = resolve(__dirname, "../src/app/admin");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Dynamic admin URLs whose record has no shop of its own, and how they stay inside the workspace. */
const BRAND_LEVEL: Record<string, string> = {
  "customers/[id]/page.tsx":
    "Clients are brand-wide and their visit history follows them to every shop; ratings and notes are filtered to the viewer's shops, and only their own shops' tickets are linked",
  "import/[runId]/errors/route.ts": "Import runs are brand-level; the route needs import.run, which only all-shops access keeps",
  "inventory/[id]/page.tsx": "A product is brand catalog; stock, ledger and orders on the page are filtered to the viewer's shops",
  "permissions/roles/[id]/page.tsx": "Roles are brand-level templates; editing needs roles.manage",
  "vendors/[id]/page.tsx": "Vendors are brand-level; the page needs vendors.manage, which only all-shops access keeps",
};

describe("every dynamic admin page and route checks the record against the tenant", () => {
  const files = walk(ADMIN)
    .filter((f) => /\[[^/]+\]/.test(relative(ADMIN, f)) && /\/(page\.tsx|route\.ts)$/.test(f))
    .map((f) => relative(ADMIN, f));

  it("finds the dynamic pages", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const f of files) {
    it(f, () => {
      const src = readFileSync(join(ADMIN, f), "utf8");
      const guarded = /\b(requireInTenant|inTenant)\(/.test(src);
      if (BRAND_LEVEL[f]) expect(guarded, `${f} is allow-listed as brand-level but calls the guard; remove it from the list`).toBe(false);
      else expect(guarded, `${f} takes a record ID from the URL but never calls inTenant/requireInTenant`).toBe(true);
    });
  }

  it("the allow-list has no stale entries", () => {
    for (const f of Object.keys(BRAND_LEVEL)) expect(files).toContain(f);
  });
});

describe("tenant helpers", () => {
  const t = { shopIds: ["a", "b"] };
  it("hasShop", () => {
    expect(hasShop(t, "a")).toBe(true);
    expect(hasShop(t, "c")).toBe(false);
    expect(hasShop(t, null)).toBe(false);
  });
  it("narrowShops refuses shops outside the workspace and defaults to all of the caller's", () => {
    expect(narrowShops(t)).toEqual(["a", "b"]);
    expect(narrowShops(t, ["b"])).toEqual(["b"]);
    expect(() => narrowShops(t, ["a", "c"])).toThrow(/outside your access/);
  });
});
