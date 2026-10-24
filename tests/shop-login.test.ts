import { describe, expect, it } from "vitest";
import { SHOP_LOGIN_CONTACT_FIELDS, cleanShopLoginCap, shopLoginLevel } from "@/domain/client-privacy";
import { drawerTimeline, moveProblem, movesOut, openingProblem } from "@/domain/drawer";
import { PAGE_ACCESS, navFor, pageAllowed } from "@/domain/navigation";
import {
  Permission,
  ROLE_TEMPLATES,
  SHOP_LOGIN_NEVER,
  SHOP_SETTING_FIELDS,
  editableShopParts,
  effectiveAccess,
  sharedLoginAccess,
  shopSettingsDenied,
  templateFor,
} from "@/domain/permissions";
import {
  DEFAULT_OPERATOR,
  cleanOperator,
  operatorMetrics,
  operatorProblem,
  operatorScript,
  operatorTakes,
  spokenHours,
  strongerChoice,
} from "@/domain/phone-operator";
import { PRESETS, presetRange, priorPeriod, quarterStart } from "@/domain/report-range";
import { REPORT_SHORTCUTS, shortcutsFor } from "@/domain/report-shortcuts";
import { cleanTaxFiling, filingFor, parsePeriod, periodKey, periodLabel, stateCode, stateName, taxShortcuts } from "@/domain/sales-tax";
import { seesStaffContact, staffContact } from "@/domain/staff-contact";

const role = (key: string) => templateFor(key)!;
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 24, h, m));

describe("shop login: the Shop Login role and its hard caps", () => {
  it("whatever the role or overrides say, a shared login never refunds, reassigns, reveals, exports or sees staff contact", () => {
    const generous = effectiveAccess(role("shop_manager"), { "clients.export": true, "clients.reveal": true }, null, "one");
    expect(generous.permissions.has("sales.refund")).toBe(true);
    const shared = sharedLoginAccess(generous);
    for (const p of SHOP_LOGIN_NEVER) expect(shared.permissions.has(p)).toBe(false);
    expect(shared.permissions.has("checkout.any")).toBe(true);
    expect(sharedLoginAccess(effectiveAccess(role("brand_owner"))).isOwner).toBe(false);
  });

  it("the Shop Login template is one shop, view-only reports and nothing the caps take away", () => {
    const t = role("shop_login");
    expect(t.defaultScope).toBe("one");
    expect(t.permissions.filter((p) => SHOP_LOGIN_NEVER.has(p as Permission))).toEqual([]);
    expect(t.permissions.filter((p) => p.endsWith(".export"))).toEqual([]);
    for (const r of ["report.end_of_day.view", "report.leaderboard.view", "report.retention.view", "report.acquisition.view", "report.sales_tax.view", "report.phone_operator.view"])
      expect(t.permissions).toContain(r);
    for (const p of ["clients.export", "clients.reveal", "staff.contact", "settings.shop", "settings.shop_details"]) expect(t.permissions).not.toContain(p);
    const nav = navFor(effectiveAccess(t, {}, null, "one").permissions).flatMap((s) => s.items.map((i) => i.href));
    expect(nav).toContain("/admin/drawer");
    expect(nav).toContain("/admin/walk-ins");
    expect(nav).not.toContain("/admin/client-data");
    expect(pageAllowed(new Set(t.permissions as Permission[]), "/admin/reports/end-of-day" as keyof typeof PAGE_ACCESS)).toBe(true);
  });

  it("managers can see staff contact and reassign; the front desk can't", () => {
    for (const k of ["brand_admin", "regional_manager", "shop_manager"]) {
      const p = effectiveAccess(role(k), {}, null, k === "brand_admin" ? "all" : "one").permissions;
      expect(p.has("staff.contact")).toBe(true);
      expect(p.has("sales.reassign")).toBe(true);
    }
    expect(role("front_desk").permissions).not.toContain("staff.contact");
    expect(role("front_desk").permissions).not.toContain("sales.reassign");
    expect(ROLE_TEMPLATES.map((t) => t.key)).toContain("shop_login");
  });

  it("client contact details are masked at most for shop logins unless the brand lifts the cap", () => {
    expect(cleanShopLoginCap(undefined)).toBe("masked");
    expect(cleanShopLoginCap("nonsense")).toBe("masked");
    for (const f of SHOP_LOGIN_CONTACT_FIELDS) {
      expect(shopLoginLevel("masked", f, "full")).toBe("masked");
      expect(shopLoginLevel("masked", f, "hidden")).toBe("hidden");
      expect(shopLoginLevel("hidden", f, "full")).toBe("hidden");
      expect(shopLoginLevel("role", f, "full")).toBe("full");
    }
    expect(shopLoginLevel("hidden", "notes", "full")).toBe("full");
  });
});

describe("staff contact masking", () => {
  const viewer = (perms: Permission[], staffId = "me") => ({ permissions: new Set(perms), staffId });

  it("people see their own contact; others need staff.contact", () => {
    expect(seesStaffContact(viewer([]), "me")).toBe(true);
    expect(seesStaffContact(viewer([]), "you")).toBe(false);
    expect(seesStaffContact(viewer(["staff.contact"]), "you")).toBe(true);
  });

  it("masks phone and email the same way as client details", () => {
    const c = staffContact(false, { email: "jordan@rayz.test", phone: "+13195551234", id: "x" });
    expect(c).toEqual({ email: "j***@rayz.test", phone: "***-***-1234", id: "x", masked: true });
    expect(staffContact(false, { email: null, phone: null })).toEqual({ email: null, phone: null, masked: true });
    expect(staffContact(true, { email: "a@b.co", phone: null }).masked).toBe(false);
  });
});

describe("shop settings, part by part", () => {
  it("each part has its own permission and 'every shop setting' covers them all", () => {
    expect(editableShopParts(new Set<Permission>(["settings.shop"]))).toEqual(["details", "hours", "booking", "checkout", "phone"]);
    expect(editableShopParts(new Set<Permission>(["settings.shop_hours", "settings.shop_booking"]))).toEqual(["hours", "booking"]);
    expect(editableShopParts(new Set<Permission>())).toEqual([]);
  });

  it("only changed fields count, and each is checked against its own part", () => {
    const hoursOnly = new Set<Permission>(["settings.shop_booking"]);
    const before = { name: "Coralville", bookingEnabled: true, twilioNumber: "+13195550000" };
    expect(shopSettingsDenied(hoursOnly, before, { ...before, bookingEnabled: false })).toEqual([]);
    expect(shopSettingsDenied(hoursOnly, before, { ...before, name: "Coralville 2", twilioNumber: "+13195550001" })).toEqual(["name", "twilioNumber"]);
    expect(SHOP_SETTING_FIELDS.twilioNumber).toBe("phone");
  });
});

describe("cash drawer", () => {
  it("runs the balance from the opening count through moves to the close", () => {
    const lines = drawerTimeline([
      { kind: "close", at: at(20), cents: 41_500 },
      { kind: "sale", at: at(10), cents: 6_000 },
      { kind: "open", at: at(9), cents: 30_000 },
      { kind: "paid_out", at: at(12), cents: 2_500, label: "Towels" },
      { kind: "refund", at: at(14), cents: 1_000 },
      { kind: "paid_in", at: at(15), cents: 10_000 },
      { kind: "tip_payout", at: at(19), cents: 1_000 },
    ]);
    expect(lines.map((l) => [l.kind, l.balanceCents])).toEqual([
      ["open", 30_000],
      ["sale", 36_000],
      ["paid_out", 33_500],
      ["refund", 32_500],
      ["paid_in", 42_500],
      ["tip_payout", 41_500],
      ["close", 41_500],
    ]);
    expect(lines.at(-1)!.varianceCents).toBe(0);
    expect(drawerTimeline([{ kind: "sale", at: at(10), cents: 500 }], 30_000)[0].balanceCents).toBe(30_500);
  });

  it("moves net out, and openings and moves are checked", () => {
    expect(
      movesOut([
        { kind: "paid_out", amountCents: 2_000 },
        { kind: "paid_in", amountCents: 500 },
      ]),
    ).toBe(1_500);
    expect(openingProblem(30_000)).toBeNull();
    expect(openingProblem(-1)).toMatch(/Enter/);
    expect(openingProblem(600_000)).toMatch(/\$5,000/);
    expect(moveProblem({ kind: "paid_out", amountCents: 1_000, reason: "Coffee" })).toBeNull();
    expect(moveProblem({ kind: "other", amountCents: 1_000, reason: "Coffee" })).toMatch(/Pick/);
    expect(moveProblem({ kind: "paid_in", amountCents: 0, reason: "Coffee" })).toMatch(/amount/);
    expect(moveProblem({ kind: "paid_in", amountCents: 100, reason: " x " })).toMatch(/what it was for/);
  });
});

describe("phone operator", () => {
  it("cleans settings and checks them", () => {
    expect(cleanOperator(null)).toEqual(DEFAULT_OPERATOR);
    expect(cleanOperator({ enabled: true, answer: "first", minutesPerCall: 99, greeting: "  Hi  " })).toEqual({ enabled: true, answer: "first", minutesPerCall: 3, greeting: "Hi" });
    expect(operatorProblem({ minutesPerCall: 0, greeting: null })).toMatch(/1 to 30/);
    expect(operatorProblem({ minutesPerCall: 4, greeting: "x".repeat(301) })).toMatch(/300/);
  });

  it("takes calls after hours by default, or first when the shop wants", () => {
    const on = { ...DEFAULT_OPERATOR, enabled: true };
    expect(operatorTakes(on, false)).toBe(true);
    expect(operatorTakes(on, true)).toBe(false);
    expect(operatorTakes({ ...on, answer: "first" }, true)).toBe(true);
    expect(operatorTakes(DEFAULT_OPERATOR, false)).toBe(false);
  });

  it("offers the shop only while it's open and has a phone", () => {
    const open = operatorScript({ shop: "Rays Coralville", greeting: null, open: true, missed: false, canRing: true });
    expect(open.intro).toBe("Thanks for calling Rays Coralville.");
    expect(open.menu).toContain("Press 3");
    const closed = operatorScript({ shop: "Rays Coralville", greeting: "Hey, it's Rays.", open: false, missed: false, canRing: true });
    expect(closed.intro).toBe("Hey, it's Rays. We're closed right now.");
    expect(closed.menu).not.toContain("Press 3");
    expect(operatorScript({ shop: "X", greeting: null, open: true, missed: true, canRing: true }).intro).toMatch(/nobody could get to the phone/);
  });

  it("reads the hours in runs from Monday", () => {
    const week = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, openMin: 540, closeMin: 1140 }));
    expect(spokenHours([...week, { weekday: 6, openMin: 480, closeMin: 900 }])).toBe("We're open Monday through Friday, 9 AM to 7 PM. Saturday, 8 AM to 3 PM. Closed Sunday.");
    expect(spokenHours([{ weekday: 6, openMin: 510, closeMin: 720 }, { weekday: 0, openMin: 510, closeMin: 720 }])).toBe(
      "We're open Saturday and Sunday, 8:30 AM to 12 PM. Closed Monday through Friday.",
    );
    expect(spokenHours([])).toMatch(/don't have opening hours/);
  });

  it("keeps the most telling key a caller pressed", () => {
    expect(strongerChoice(null, "hours")).toBe("hours");
    expect(strongerChoice("hours", "book")).toBe("book");
    expect(strongerChoice("book", "none")).toBe("book");
  });

  it("counts calls, bookings, book rate and minutes saved", () => {
    const m = operatorMetrics(
      [
        { operator: true, status: "after_hours", autoTextSent: true, choice: "book", bookedCents: 4_500 },
        { operator: true, status: "after_hours", autoTextSent: false, choice: "hours", bookedCents: null },
        { operator: true, status: "ringing", autoTextSent: false, choice: "shop", bookedCents: 3_000 },
        { operator: false, status: "answered", autoTextSent: false, choice: null, bookedCents: null },
        { operator: false, status: "missed", autoTextSent: true, choice: null, bookedCents: null },
      ],
      3,
    );
    expect(m).toMatchObject({ calls: 5, staffAnswered: 1, handled: 3, missed: 1, linksTexted: 1, bookings: 2, bookedCents: 7_500, minutesSaved: 6 });
    expect(m.bookRate).toBeCloseTo(2 / 3);
    expect(m.answerRate).toBeCloseTo(4 / 5);
    expect(operatorMetrics([], 3).bookRate).toBeNull();
  });
});

describe("sales tax by state", () => {
  it("normalises states and periods", () => {
    expect(stateCode("ia ")).toBe("IA");
    expect(stateCode("Iowa")).toBe("IA");
    expect(stateCode("Ontario")).toBe("ONTARIO");
    expect(stateName("")).toBe("No state set");
    expect(stateName("IL")).toBe("Illinois");
    expect(periodKey("2026-09-14", "month")).toBe("2026-09");
    expect(periodKey("2026-09-14", "quarter")).toBe("2026-Q3");
    expect(periodLabel("2026-Q3")).toBe("Q3 2026");
    expect(periodLabel("2026-01")).toBe("Jan 2026");
    expect(parsePeriod("year")).toBeNull();
  });

  it("Iowa files monthly unless the brand says otherwise; other states quarterly", () => {
    expect(filingFor({}, "IA")).toBe("monthly");
    expect(filingFor({}, "IL")).toBe("quarterly");
    expect(filingFor(cleanTaxFiling({ iowa: "quarterly", IL: "monthly", XX: "weekly" }), "IA")).toBe("quarterly");
    expect(cleanTaxFiling({ iowa: "quarterly", XX: "weekly" })).toEqual({ IA: "quarterly" });
    expect(taxShortcuts(["IA", "Iowa", "IL", ""], {})).toEqual([
      { state: "IA", frequency: "monthly", label: "Iowa monthly sales tax", query: "state=IA&period=month&preset=lastmonth" },
      { state: "IL", frequency: "quarterly", label: "Illinois quarterly sales tax", query: "state=IL&period=quarter&preset=lastquarter" },
    ]);
  });
});

describe("report ranges and saved reports", () => {
  it("has this quarter and last quarter", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(expect.arrayContaining(["quarter", "lastquarter"]));
    expect(quarterStart("2026-11-03")).toBe("2026-10-01");
    expect(presetRange("quarter", "2026-11-03")).toEqual({ from: "2026-10-01", to: "2026-11-03" });
    expect(presetRange("lastquarter", "2026-11-03")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(presetRange("lastquarter", "2026-02-10")).toEqual({ from: "2025-10-01", to: "2025-12-31" });
  });

  it("a quarter or month compares with the whole one before; other ranges with the same length", () => {
    expect(priorPeriod("2026-07-01", "2026-09-30")).toEqual({ from: "2026-04-01", to: "2026-06-30" });
    expect(priorPeriod("2026-10-01", "2026-10-24", "quarter")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(priorPeriod("2026-10-01", "2026-10-24", "month")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(priorPeriod("2026-10-01", "2026-10-24")).toEqual({ from: "2026-09-07", to: "2026-09-30" });
    expect(priorPeriod("2026-02-01", "2026-02-28")).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(priorPeriod("2026-09-25", "2026-10-24")).toEqual({ from: "2026-08-26", to: "2026-09-24" });
  });

  it("saved reports add one sales tax shortcut per state", () => {
    const s = shortcutsFor(["IA", "IL"], {});
    expect(s.slice(0, REPORT_SHORTCUTS.length)).toEqual(REPORT_SHORTCUTS);
    expect(s.slice(REPORT_SHORTCUTS.length).map((x) => [x.label, x.report])).toEqual([
      ["Iowa monthly sales tax", "sales_tax"],
      ["Illinois quarterly sales tax", "sales_tax"],
    ]);
    expect(REPORT_SHORTCUTS.map((x) => x.label)).toEqual(expect.arrayContaining(["End of day", "Tips", "Gross and net sales", "Employee summary", "Total collected"]));
  });
});
