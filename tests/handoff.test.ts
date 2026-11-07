/**
 * The customer screen's rules without a database: tip presets and choices, the client's steps,
 * whole-cent tip splits that always add up, signatures, card amounts, settings validation, and the
 * static wiring that keeps the screen locked to its ticket.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHOP_HANDOFF,
  DEFAULT_TIP_SCREEN,
  ShopHandoffSchema,
  TipScreenSchema,
  amountsFor,
  bigTip,
  brandHandoff,
  effectiveTips,
  handoffSteps,
  screenTipProblem,
  shopHandoff,
  shopHandoffProblem,
  signatureProblem,
  splitBarbers,
  splitCents,
  tipChoices,
  tipScreen,
  tipScreenProblem,
  tipWeights,
} from "@/domain/handoff";
import { LocationDraft, draftDefaults } from "@/domain/location-draft";
import { BRAND_ONLY, FEATURE_PERMISSIONS, ROLE_TEMPLATES } from "@/domain/permissions";

describe("tip presets", () => {
  it("validates percent and dollar presets", () => {
    expect(tipScreenProblem(DEFAULT_TIP_SCREEN)).toBeNull();
    expect(tipScreenProblem({ ...DEFAULT_TIP_SCREEN, values: [] })).toMatch(/at least one/);
    expect(tipScreenProblem({ ...DEFAULT_TIP_SCREEN, values: [10, 15, 18, 20, 25] })).toMatch(/Up to 4/);
    expect(tipScreenProblem({ ...DEFAULT_TIP_SCREEN, values: [20, 20] })).toMatch(/different/);
    expect(tipScreenProblem({ ...DEFAULT_TIP_SCREEN, values: [0] })).toMatch(/1 to 100/);
    expect(tipScreenProblem({ ...DEFAULT_TIP_SCREEN, values: [18.5] })).toMatch(/whole/);
    expect(tipScreenProblem({ type: "amount", values: [500, 1000], allowCustom: true, allowNoTip: true })).toBeNull();
    expect(tipScreenProblem({ type: "amount", values: [50], allowCustom: true, allowNoTip: true })).toMatch(/\$1 to \$500/);
    expect(tipScreenProblem({ type: "amount", values: [60_000], allowCustom: true, allowNoTip: true })).toMatch(/\$1 to \$500/);
  });

  it("reads stored settings defensively: bad presets fall back to the brand's, the brand's to the default", () => {
    expect(tipScreen(null)).toBeNull();
    expect(tipScreen({ type: "percent", values: [0, 200] })).toBeNull();
    expect(tipScreen({ type: "amount", values: [500], allowNoTip: false })).toEqual({ type: "amount", values: [500], allowCustom: true, allowNoTip: false });
    expect(brandHandoff(undefined).tips).toEqual(DEFAULT_TIP_SCREEN);
    expect(brandHandoff({ tips: { type: "percent", values: [] } }).tips).toEqual(DEFAULT_TIP_SCREEN);
    const brand = brandHandoff({ tips: { type: "percent", values: [18, 20, 25] } });
    expect(effectiveTips(shopHandoff({}), brand).values).toEqual([18, 20, 25]);
    expect(effectiveTips(shopHandoff({ tips: { type: "amount", values: [300] } }), brand)).toMatchObject({ type: "amount", values: [300] });
  });

  it("shop rules default sensibly and clamp the thank-you time", () => {
    expect(shopHandoff(undefined)).toEqual(DEFAULT_SHOP_HANDOFF);
    expect(shopHandoff({ tipEntry: "reader", signature: true, unlock: "manager", afterPayment: "pin", thankYouSeconds: 999 })).toMatchObject({
      tipEntry: "reader",
      signature: true,
      unlock: "manager",
      afterPayment: "pin",
      thankYouSeconds: 60,
    });
    expect(shopHandoff({ tipEntry: "nfc", unlock: "anyone", thankYouSeconds: "x" })).toMatchObject({ tipEntry: "screen", unlock: "staff", thankYouSeconds: 8 });
    expect(shopHandoffProblem({ ...DEFAULT_SHOP_HANDOFF, thankYouSeconds: 2 })).toMatch(/3 to 60/);
    expect(shopHandoffProblem({ ...DEFAULT_SHOP_HANDOFF, tips: { ...DEFAULT_TIP_SCREEN, values: [] } })).toMatch(/at least one/);
  });

  it("the settings schemas reject what the editors can't save", () => {
    expect(TipScreenSchema.safeParse({ type: "percent", values: [18, 20, 25], allowCustom: true, allowNoTip: false }).success).toBe(true);
    const bad = TipScreenSchema.safeParse({ type: "percent", values: [18, 18], allowCustom: true, allowNoTip: true });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].message).toMatch(/different/);
    expect(ShopHandoffSchema.safeParse({ ...DEFAULT_SHOP_HANDOFF, thankYouSeconds: 61 }).success).toBe(false);
    expect(ShopHandoffSchema.safeParse({ ...DEFAULT_SHOP_HANDOFF, unlock: "owner" }).success).toBe(false);
    expect(ShopHandoffSchema.safeParse(DEFAULT_SHOP_HANDOFF).success).toBe(true);
  });

  it("a new location's draft gets the default customer screen unless the wizard sets one", () => {
    const base = draftDefaults({ name: "Ray'z Test", slug: "test", address: "1 Main", city: "Iowa City", state: "IA", zip: "52240" });
    expect(LocationDraft.parse(base).handoff).toEqual(DEFAULT_SHOP_HANDOFF);
    const own = LocationDraft.parse({ ...base, handoff: { ...DEFAULT_SHOP_HANDOFF, signature: true, tips: { type: "amount", values: [500], allowCustom: false, allowNoTip: true } } });
    expect(own.handoff).toMatchObject({ signature: true, tips: { type: "amount", values: [500] } });
    expect(LocationDraft.safeParse({ ...base, handoff: { ...DEFAULT_SHOP_HANDOFF, tips: { type: "percent", values: [], allowCustom: true, allowNoTip: true } } }).success).toBe(false);
  });
});

describe("tip choices", () => {
  it("percent buttons show the dollars on the services; dollar buttons are as set; zero-dollar buttons are dropped", () => {
    expect(tipChoices({ type: "percent", values: [18, 20, 25], allowCustom: true, allowNoTip: true }, 4000)).toEqual([
      { key: "p18", label: "18%", detail: "$7.20", cents: 720 },
      { key: "p20", label: "20%", detail: "$8", cents: 800 },
      { key: "p25", label: "25%", detail: "$10", cents: 1000 },
    ]);
    expect(tipChoices({ type: "amount", values: [500, 1250], allowCustom: true, allowNoTip: true }, 0)).toEqual([
      { key: "a500", label: "$5", detail: null, cents: 500 },
      { key: "a1250", label: "$12.50", detail: null, cents: 1250 },
    ]);
    expect(tipChoices(DEFAULT_TIP_SCREEN, 0)).toEqual([]);
  });

  it("caps tips typed on the screen and double-checks unusually big ones", () => {
    expect(screenTipProblem(0)).toBeNull();
    expect(screenTipProblem(50_000)).toBeNull();
    expect(screenTipProblem(50_001)).toMatch(/at the counter/);
    expect(screenTipProblem(-1)).toMatch(/\$0 or more/);
    expect(screenTipProblem(1.5)).toMatch(/\$0 or more/);
    expect(bigTip(2000, 3000)).toBe(false);
    expect(bigTip(2500, 4000)).toBe(true);
    expect(bigTip(1500, 1000)).toBe(false);
  });
});

describe("the client's steps", () => {
  it("tip, optional signature, receipt, pay; tips on a reader skip the screen's tip step only when there's a reader to pay on", () => {
    expect(handoffSteps({ tipEntry: "screen", signature: false }, { readerTips: false })).toEqual(["tip", "receipt", "pay", "done"]);
    expect(handoffSteps({ tipEntry: "screen", signature: true }, { readerTips: true })).toEqual(["tip", "signature", "receipt", "pay", "done"]);
    expect(handoffSteps({ tipEntry: "reader", signature: true }, { readerTips: true })).toEqual(["signature", "receipt", "pay", "done"]);
    expect(handoffSteps({ tipEntry: "reader", signature: false }, { readerTips: false })).toEqual(["tip", "receipt", "pay", "done"]);
  });

  it("charges credit cards the surcharged amount and confirms the matching total", () => {
    const v = { dueCents: 4500, creditDueCents: 4635, totalCents: 5000, creditTotalCents: 5135 };
    expect(amountsFor(v, "credit")).toEqual({ chargeCents: 4635, totalCents: 5135 });
    expect(amountsFor(v, "debit")).toEqual({ chargeCents: 4500, totalCents: 5000 });
    expect(amountsFor(v, "prepaid")).toEqual({ chargeCents: 4500, totalCents: 5000 });
    expect(amountsFor(v, null)).toEqual({ chargeCents: 4500, totalCents: 5000 });
  });

  it("accepts only signature path data", () => {
    expect(signatureProblem("M10 10 L20 20 L30 30 L40 40")).toBeNull();
    expect(signatureProblem("")).toMatch(/Sign/);
    expect(signatureProblem("M10 10 L20 20")).toMatch(/Sign/);
    expect(signatureProblem('M1 1 L2 2 L3 3 L4 4"/><script>')).toMatch(/isn't a signature/);
    expect(signatureProblem(`M0 0 ${"L1 1 ".repeat(5000)}`)).toMatch(/too long/);
  });
});

describe("split tips", () => {
  const ids = (m: Map<string, number>) => Object.fromEntries(m);

  it("gives whole cents in proportion, largest remainder first, ties to the lower id, always adding up", () => {
    expect(ids(splitCents(1000, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }]))).toEqual({ a: 500, b: 500 });
    expect(ids(splitCents(1001, [{ id: "b", weight: 1 }, { id: "a", weight: 1 }]))).toEqual({ a: 501, b: 500 });
    expect(ids(splitCents(1000, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }, { id: "c", weight: 1 }]))).toEqual({ a: 334, b: 333, c: 333 });
    expect(ids(splitCents(1000, [{ id: "a", weight: 4500 }, { id: "b", weight: 1500 }]))).toEqual({ a: 750, b: 250 });
    expect(ids(splitCents(101, [{ id: "a", weight: 2 }, { id: "b", weight: 1 }]))).toEqual({ a: 67, b: 34 });
    expect(ids(splitCents(0, [{ id: "a", weight: 1 }, { id: "b", weight: 3 }]))).toEqual({ a: 0, b: 0 });
    expect(splitCents(500, []).size).toBe(0);
    expect(splitCents(500, [{ id: "a", weight: 0 }]).size).toBe(0);
    for (let total = 0; total < 400; total += 7) {
      const w = [{ id: "x", weight: 3700 }, { id: "y", weight: 1100 }, { id: "z", weight: 900 }];
      expect([...splitCents(total, w).values()].reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("weights barbers by their services' net, or evenly; products don't count; all-free services split evenly", () => {
    const lines = [
      { kind: "service", staffId: "b", netCents: 3000 },
      { kind: "addon", staffId: "b", netCents: 500 },
      { kind: "service", staffId: "a", netCents: 1500 },
      { kind: "product", staffId: null, netCents: 2000 },
    ];
    expect(tipWeights(lines, "services")).toEqual([
      { staffId: "a", weight: 1500 },
      { staffId: "b", weight: 3500 },
    ]);
    expect(tipWeights(lines, "even")).toEqual([
      { staffId: "a", weight: 1 },
      { staffId: "b", weight: 1 },
    ]);
    expect(tipWeights([{ kind: "service", staffId: "a", netCents: 0 }, { kind: "service", staffId: "b", netCents: 0 }], "services").map((w) => w.weight)).toEqual([1, 1]);
  });

  it("splits only when someone besides the ticket's barber did a service", () => {
    const one = [{ kind: "service", staffId: "a" }];
    expect(splitBarbers(one, "a")).toEqual([]);
    expect(splitBarbers(one, "z")).toEqual(["a"]);
    expect(splitBarbers([...one, { kind: "addon", staffId: "b" }, { kind: "product", staffId: "c" }], "a")).toEqual(["a", "b"]);
    expect(splitBarbers([{ kind: "gift_card", staffId: "b" }], "a")).toEqual([]);
  });
});

describe("permissions", () => {
  it("managers can take back a device where a manager PIN is required; brand tip presets are brand-wide", () => {
    expect(FEATURE_PERMISSIONS.find((p) => p.key === "handoff.unlock")!.group).toBe("Point of sale");
    expect(BRAND_ONLY.has("handoff.settings")).toBe(true);
    const tpl = (key: string) => ROLE_TEMPLATES.find((r) => r.key === key)!;
    expect(tpl("shop_manager").permissions).toContain("handoff.unlock");
    expect(tpl("barber").permissions).not.toContain("handoff.unlock");
  });
});

describe("the lock is wired everywhere", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("every customer screen action checks this browser holds that ticket's hand-off", () => {
    const actions = src("src/app/handoff/[id]/actions.ts");
    expect(actions.startsWith('"use server"')).toBe(true);
    const bodies = actions.split(/\nexport async function /).slice(1);
    expect(bodies.length).toBeGreaterThan(8);
    for (const b of bodies) expect(b.split(/\n(?:export )?(?:async )?function /)[0], b.slice(0, b.indexOf("("))).toMatch(/await onThisDevice\(id\)/);
  });

  it("the middleware runs on every page, and the staff session is off while a hand-off holds the browser", () => {
    expect(src("src/middleware.ts")).toMatch(/matcher: \["\/\(\(\?!_next\/\|api\/\|\.\*\\\\\.\.\*\)\.\*\)"\]/);
    expect(src("src/server/auth/staff.ts")).toMatch(/lockedHandoff\(jar\.get\(HANDOFF_COOKIE\)/);
    expect(src("src/app/admin/layout.tsx")).toContain("<BfcacheGuard />");
  });

  it("the customer screen shows nothing of the staff app and keeps the back button on the page", () => {
    const screen = src("src/app/handoff/[id]/customer-screen.tsx");
    expect(screen).toContain('history.pushState(null, "", location.href)');
    expect(screen).not.toMatch(/from "\.\.\/\.\.\/admin\/(nav|layout)/);
    expect(screen).not.toMatch(/href="\/admin/);
    const page = src("src/app/handoff/[id]/page.tsx");
    expect(page).toMatch(/handoffIdFrom\(jar\.get\(HANDOFF_COOKIE\)/);
  });
});
