import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { staffLandingPath } from "@/domain/front-desk";
import { showDemoLogins } from "@/lib/deployment";

describe("sidebar map", () => {
  it("names every current sidebar page once", () => {
    const nav = readFileSync("src/domain/navigation.ts", "utf8");
    const section = nav.slice(nav.indexOf("const SECTIONS"), nav.indexOf("STRIPE_PAYOUT_PAGES"));
    const hrefs = [...section.matchAll(/href: "(\/admin[^"]+)"/g)].map((m) => m[1]);
    const map = readFileSync("docs/sidebar-map.md", "utf8");
    expect(hrefs.length).toBeGreaterThan(40);
    for (const href of hrefs) {
      const hits = map.match(new RegExp("`" + href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "`", "g"))?.length ?? 0;
      expect(hits, href).toBe(1);
    }
  });
});

describe("staff landing", () => {
  it("opens Checkout for a shop login, and Today for everyone else who can sell", () => {
    expect(staffLandingPath({ kind: "shop", next: "", canSell: true })).toBe("/admin/sales");
    expect(staffLandingPath({ kind: "person", next: "", canSell: true })).toBe("/admin");
    expect(staffLandingPath({ kind: "person", next: "", canSell: false })).toBe("/admin/calendar");
    expect(staffLandingPath({ kind: "shop", next: "/admin/calendar", canSell: true })).toBe("/admin/calendar");
    expect(staffLandingPath({ kind: "shop", next: "https://evil.test", canSell: true })).toBe("/admin/sales");
  });
});

describe("demo logins", () => {
  it("lists them only on a local demo, never on Vercel", () => {
    expect(showDemoLogins({ DEMO_MODE: "true", VERCEL: "1", NODE_ENV: "production" })).toBe(false);
    expect(showDemoLogins({ DEMO_MODE: "true", SHOW_DEMO_LOGINS: "true", VERCEL: "1" })).toBe(false);
    expect(showDemoLogins({ DEMO_MODE: "true", NODE_ENV: "development" })).toBe(true);
    expect(showDemoLogins({ NODE_ENV: "development" })).toBe(true);
    expect(showDemoLogins({ NODE_ENV: "production" })).toBe(false);
    const page = readFileSync("src/app/login/page.tsx", "utf8");
    expect(page).toContain("showDemoLogins()");
    expect(page).not.toContain("SHOW_DEMO_LOGINS");
  });

  it("puts Sign in at the end of the public nav", () => {
    const layout = readFileSync("src/app/(public)/layout.tsx", "utf8");
    const book = layout.indexOf("Book");
    const sign = layout.indexOf("Sign in");
    expect(book).toBeGreaterThan(0);
    expect(sign).toBeGreaterThan(book);
    expect(layout).not.toContain(">Staff<");
  });
});
