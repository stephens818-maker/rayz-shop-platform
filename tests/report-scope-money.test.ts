/**
 * Report scope (own numbers, their shops, every shop), dollar amounts in reports, App config, the
 * Apprentice and Bookkeeper / Accountant templates, and how far each permission reaches.
 */
import { describe, expect, it } from "vitest";
import { AREA_ROWS, blockedBecause, followsReportScope, heldReach, levelReach, reportReach } from "@/domain/permission-areas";
import {
  BRAND_ONLY,
  OWNER_GRANTS,
  Permission,
  ROLE_TEMPLATES,
  ROLE_TEMPLATE_KEYS,
  RoleDef,
  SHOP_LOGIN_NEVER,
  effectiveAccess,
  reportView,
  sharedLoginAccess,
} from "@/domain/permissions";
import { HIDDEN_DOLLARS, MONEY_HIDDEN_NOTE, scrubDollars, tableWithoutMoney, withoutMoney } from "@/domain/report-money";
import type { ReportTable } from "@/domain/report-views";

const tpl = (key: string) => ROLE_TEMPLATES.find((t) => t.key === key)!;
const role = (permissions: string[], extra: Partial<RoleDef> = {}): RoleDef => ({ key: null, name: "Test", permissions, maxDiscountPct: 10, ...extra });
const rowOf = (id: string) => AREA_ROWS.find((r) => r.id === id)!;
const perms = (...p: string[]) => new Set(p as Permission[]);

describe("templates Charles asked for", () => {
  it("are all there, in order", () => {
    const names = Object.fromEntries(ROLE_TEMPLATES.map((t) => [t.key, t.name]));
    expect(ROLE_TEMPLATES.map((t) => t.key)).toEqual([...ROLE_TEMPLATE_KEYS]);
    expect(names.brand_admin).toBe("Brand Admin");
    expect(names.regional_manager).toMatch(/Regional|District/);
    expect(names.shop_manager).toBe("Shop Manager");
    expect(names.front_desk).toBe("Front Desk");
    expect(names.barber).toBe("Barber");
    expect(names.apprentice).toBe("Apprentice");
    expect(names.bookkeeper).toBe("Bookkeeper / Accountant");
  });

  it("Apprentice: own column, no discounts, refunds or blocks, and no dollar amounts", () => {
    const a = effectiveAccess(tpl("apprentice"), {}, null, "one");
    for (const p of ["pos.discount", "pos.price_override", "sales.refund", "sales.void", "blocks.own", "reports.money", "reports.all_staff", "calendar.view_all", "checkout.any"])
      expect(a.permissions.has(p as Permission), p).toBe(false);
    expect(a.maxDiscountPct).toBe(0);
    expect(a.permissions.has(reportView("my_sales"))).toBe(true);
    expect([...a.permissions].some((p) => p.endsWith(".export"))).toBe(false);
    expect(tpl("apprentice").defaultScope).toBe("one");
  });

  it("Bookkeeper / Accountant is read-only", () => {
    const a = effectiveAccess(tpl("bookkeeper"));
    const readOnly = new Set(["sales.view", "reports.all_staff", "reports.all_shops", "reports.money", "staff.view", "payroll.rates", "payroll.export", "exports.accounting"]);
    expect([...a.permissions].filter((p) => !readOnly.has(p) && !p.startsWith("report."))).toEqual([]);
    expect(a.permissions.has("exports.accounting")).toBe(true);
    expect(a.maxDiscountPct).toBe(0);
  });

  it("only Bookkeeper and Brand Admin report on every shop out of the box", () => {
    const wide = ROLE_TEMPLATES.filter((t) => t.key !== "brand_owner" && effectiveAccess(t).permissions.has("reports.all_shops")).map((t) => t.key);
    expect(wide.sort()).toEqual(["bookkeeper", "brand_admin"]);
  });

  it("every template that sees reports today still sees dollar amounts, except Apprentice", () => {
    const noMoney = ROLE_TEMPLATES.filter((t) => t.key !== "brand_owner" && !effectiveAccess(t).permissions.has("reports.money")).map((t) => t.key);
    expect(noMoney).toEqual(["apprentice"]);
  });
});

describe("report scope and dollar amounts", () => {
  it("every shop's reports come with everyone's numbers", () => {
    const a = effectiveAccess(role(["reports.all_shops"]), {}, null, "one");
    expect(a.permissions.has("reports.all_staff")).toBe(true);
  });

  it("never on a shop login", () => {
    expect(SHOP_LOGIN_NEVER.has("reports.all_shops")).toBe(true);
    const a = sharedLoginAccess(effectiveAccess(role(["reports.all_shops", "reports.money"]), {}, null, "one"));
    expect(a.permissions.has("reports.all_shops")).toBe(false);
    expect(a.permissions.has("reports.money")).toBe(true);
  });

  it("the QuickBooks journal needs dollar amounts", () => {
    const base = ["exports.accounting", reportView("sales_summary")];
    expect(effectiveAccess(role(base)).permissions.has("exports.accounting")).toBe(false);
    expect(effectiveAccess(role([...base, "reports.money"])).permissions.has("exports.accounting")).toBe(true);
    expect(effectiveAccess(tpl("bookkeeper"), { "reports.money": false }).permissions.has("exports.accounting")).toBe(false);
    const c = { scope: "all" as const, brandLevel: true, shopLogin: false, ownerMismatch: false };
    expect(blockedBecause("exports.accounting", { ...c, held: perms(reportView("sales_summary")) })).toBe("needs dollar amounts in reports");
    expect(blockedBecause("exports.accounting", { ...c, held: perms(reportView("sales_summary"), "reports.money") })).toBeNull();
  });

  it("an override takes dollar amounts away from Brand Admin only when Brand Admin isn't at every shop", () => {
    expect(effectiveAccess(tpl("brand_admin"), { "reports.money": false }, null, "all").permissions.has("reports.money")).toBe(true);
    expect(effectiveAccess(tpl("shop_manager"), { "reports.money": false }, null, "one").permissions.has("reports.money")).toBe(false);
  });

  it("reportReach reads the scope row", () => {
    expect(reportReach(perms())).toBe("own");
    expect(reportReach(perms("reports.all_staff"))).toBe("shops");
    expect(reportReach(perms("reports.all_staff"), true)).toBe("all");
    expect(reportReach(perms("reports.all_shops"))).toBe("all");
  });
});

describe("App config", () => {
  it("is brand-only, granted by the Brand Owner, and not in any template", () => {
    expect(BRAND_ONLY.has("settings.app")).toBe(true);
    expect(OWNER_GRANTS.has("settings.app")).toBe(true);
    for (const t of ROLE_TEMPLATES.filter((x) => x.key !== "brand_owner")) expect(effectiveAccess(t).permissions.has("settings.app"), t.key).toBe(false);
    expect(effectiveAccess(role(["settings.app"]), {}, null, "selected").permissions.has("settings.app")).toBe(false);
  });
});

describe("how far each permission reaches", () => {
  it("own levels are own data, brand-only ones every shop, the rest their shops", () => {
    expect(levelReach(rowOf("calendar"), 0)).toBe("own");
    expect(levelReach(rowOf("calendar"), 2)).toBe("shops");
    expect(levelReach(rowOf("timesheets"), 1)).toBe("own");
    expect(levelReach(rowOf("timesheets"), 3)).toBe("shops");
    expect(levelReach(rowOf("catalog"), 2)).toBe("all");
    expect(levelReach(rowOf("payroll.rates"), 1)).toBe("shops");
    expect(levelReach(rowOf("settings.brand"), 1)).toBe("all");
    expect(levelReach(rowOf("client_edit"), 0)).toBe("shops");
    expect(levelReach(rowOf("client_lookup"), 0)).toBe("shops");
    expect(levelReach(rowOf("client_lookup"), 1)).toBe("all");
    expect(levelReach(rowOf("refunds"), 0)).toBeNull();
  });

  it("every level that gives something has a reach, except reports, which follow the report scope", () => {
    for (const r of AREA_ROWS)
      r.levels.forEach((l, i) => {
        if (l.key === "none" || followsReportScope(r)) return;
        expect(levelReach(r, i), `${r.id} ${l.key}`).not.toBeNull();
      });
    expect(followsReportScope(rowOf("report.sales_summary"))).toBe(true);
    expect(followsReportScope(rowOf("reports.money"))).toBe(true);
    expect(followsReportScope(rowOf("report_scope"))).toBe(false);
  });

  it("reports reach as far as the role's report scope", () => {
    const r = rowOf("report.sales_summary");
    expect(heldReach(r, perms())).toBeNull();
    expect(heldReach(r, perms(reportView("sales_summary")))).toBe("own");
    expect(heldReach(r, perms(reportView("sales_summary"), "reports.all_staff"))).toBe("shops");
    expect(heldReach(r, perms(reportView("sales_summary"), "reports.all_staff"), true)).toBe("all");
    expect(heldReach(r, perms(reportView("sales_summary"), "reports.all_shops", "reports.all_staff"))).toBe("all");
    expect(heldReach(rowOf("report_scope"), perms("reports.all_shops", "reports.all_staff"))).toBe("all");
    expect(heldReach(rowOf("report_scope"), perms())).toBe("own");
    expect(heldReach(rowOf("calendar"), perms("calendar.view_all", "calendar.manage"))).toBe("shops");
    expect(heldReach(rowOf("calendar"), perms("calendar.view_all", "calendar.manage"), true)).toBe("all");
    expect(heldReach(rowOf("calendar"), perms(), true)).toBe("own");
  });
});

describe("hiding dollar amounts", () => {
  const table: ReportTable = {
    id: "t",
    title: "Sales over $1,000",
    subtitle: "Tips of $5.50 included",
    columns: [
      { label: "Barber", kind: "text" },
      { label: "Visits", kind: "int" },
      { label: "Sales", kind: "money" },
      { label: "Rebook", kind: "pct" },
    ],
    rows: [
      ["Ray", 12, 48000, 0.5],
      ["Note: -$20 refund", 1, -2000, null],
    ],
  } as ReportTable;

  it("scrubs dollar amounts written into text", () => {
    expect(scrubDollars("Sales $1,234.56, refunds -$5, avg +$2.00, total $12k")).toBe(`Sales ${HIDDEN_DOLLARS}, refunds ${HIDDEN_DOLLARS}, avg ${HIDDEN_DOLLARS}, total ${HIDDEN_DOLLARS}`);
    expect(scrubDollars("12 visits, 50% rebooked")).toBe("12 visits, 50% rebooked");
  });

  it("empties money columns and money rows, and keeps counts and rates", () => {
    const t = tableWithoutMoney(table);
    expect(t.rows).toEqual([
      ["Ray", 12, null, 0.5],
      [`Note: ${HIDDEN_DOLLARS} refund`, 1, null, null],
    ]);
    expect(t.title).toBe(`Sales over ${HIDDEN_DOLLARS}`);
    expect(t.subtitle).toBe(`Tips of ${HIDDEN_DOLLARS} included`);
    const byRow = tableWithoutMoney({ ...table, columns: table.columns.map((c) => ({ ...c, kind: c.kind === "money" ? "int" : c.kind })), rowKinds: [undefined, "money"] } as ReportTable);
    expect(byRow.rows[0]).toEqual(["Ray", 12, 48000, 0.5]);
    expect(byRow.rows[1]).toEqual([`Note: ${HIDDEN_DOLLARS} refund`, null, null, null]);
  });

  it("scrubs stats and notes and says why", () => {
    const d = withoutMoney({ stats: [{ label: "Sales", value: "$480.00", hint: "12 visits, $40 a visit" }, { label: "Visits", value: "12" }], tables: [table], notes: ["Refunds of $20 left out."] });
    expect(d.stats).toEqual([{ label: "Sales", value: HIDDEN_DOLLARS, hint: `12 visits, ${HIDDEN_DOLLARS} a visit` }, { label: "Visits", value: "12" }]);
    expect(d.notes).toEqual([MONEY_HIDDEN_NOTE, `Refunds of ${HIDDEN_DOLLARS} left out.`]);
    expect(JSON.stringify(d)).not.toMatch(/\$\d/);
  });
});
