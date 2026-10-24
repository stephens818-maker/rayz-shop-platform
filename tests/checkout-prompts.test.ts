import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CheckoutPromptSettingsSchema,
  DEFAULT_REASONS,
  PROMPT_DEFAULTS,
  type PromptRule,
  candidateDays,
  pickTimes,
  promptSettings,
  rankProducts,
  reasonProblem,
  rebookInterval,
  reminderDay,
  requiredMessage,
  resolvePrompt,
  ruleTarget,
  stockStatus,
  unansweredRequired,
} from "@/domain/checkout-prompts";
import { EVENTS } from "@/domain/analytics";
import { TEMPLATE_DEFS, templateProblem } from "@/domain/message-templates";
import { PAGE_ACCESS, pageAllowed } from "@/domain/navigation";
import { BRAND_ONLY, REPORTS, reportExport, reportView, templateFor } from "@/domain/permissions";

describe("checkout prompt settings", () => {
  it("defaults to both prompts on, skippable, 3 times, 28 days and reminders 3 days ahead", () => {
    expect(promptSettings(null)).toEqual(PROMPT_DEFAULTS);
    expect(PROMPT_DEFAULTS.rebook).toMatchObject({ enabled: true, mode: "skippable", options: 3, defaultDays: 28, reminders: true, reminderLeadDays: 3, reasons: DEFAULT_REASONS });
    expect(PROMPT_DEFAULTS.product).toMatchObject({ enabled: true, mode: "skippable", max: 4, pastPurchases: true });
  });

  it("reads stored settings field by field, keeping the default for anything that doesn't parse", () => {
    const s = promptSettings({ rebook: { mode: "acknowledge", options: 9, defaultDays: 42, reasons: ["Busy", "Busy", "Price"] }, product: { enabled: false, max: "lots" } });
    expect(s.rebook).toMatchObject({ mode: "acknowledge", options: 3, defaultDays: 42, reasons: ["Busy", "Price"] });
    expect(s.product).toMatchObject({ enabled: false, max: 4 });
  });

  it("refuses what the settings page can't save", () => {
    const ok = CheckoutPromptSettingsSchema.safeParse({ rebook: { ...PROMPT_DEFAULTS.rebook }, product: { ...PROMPT_DEFAULTS.product } });
    expect(ok.success).toBe(true);
    for (const bad of [{ options: 1 }, { defaultDays: 3 }, { defaultDays: 400 }, { reminderLeadDays: 30 }, { reasons: ["x".repeat(121)] }, { mode: "always" }]) {
      expect(CheckoutPromptSettingsSchema.safeParse({ rebook: { ...PROMPT_DEFAULTS.rebook, ...bad }, product: PROMPT_DEFAULTS.product }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(CheckoutPromptSettingsSchema.safeParse({ rebook: PROMPT_DEFAULTS.rebook, product: { ...PROMPT_DEFAULTS.product, max: 9 } }).success).toBe(false);
  });
});

describe("who sees a prompt", () => {
  const shop = "s1";
  const rule = (r: Partial<PromptRule>): PromptRule => ({ prompt: "rebook", shopId: null, roleId: null, staffId: null, enabled: false, ...r });
  const who = { shopId: shop, roleId: "front", barberId: "b1" };

  it("follows the brand with no overrides", () => {
    expect(resolvePrompt("rebook", true, [], who)).toEqual({ enabled: true, source: "brand" });
    expect(resolvePrompt("rebook", false, [], who)).toEqual({ enabled: false, source: "brand" });
  });

  it("takes the most specific override: barber, then role, then location", () => {
    const rules = [rule({ shopId: shop, enabled: false }), rule({ roleId: "front", enabled: true }), rule({ staffId: "b1", enabled: false })];
    expect(resolvePrompt("rebook", true, rules, who)).toEqual({ enabled: false, source: "barber" });
    expect(resolvePrompt("rebook", true, rules, { ...who, barberId: "b2" })).toEqual({ enabled: true, source: "role" });
    expect(resolvePrompt("rebook", true, rules, { ...who, barberId: null, roleId: "mgr" })).toEqual({ enabled: false, source: "location" });
    expect(resolvePrompt("rebook", true, rules, { shopId: "s2", roleId: "mgr", barberId: null })).toEqual({ enabled: true, source: "brand" });
  });

  it("turns a prompt on for one location when the brand has it off, and keeps prompts apart", () => {
    const rules = [rule({ shopId: shop, enabled: true }), rule({ prompt: "product", shopId: shop, enabled: false })];
    expect(resolvePrompt("rebook", false, rules, who).enabled).toBe(true);
    expect(resolvePrompt("product", true, rules, who).enabled).toBe(false);
    expect(ruleTarget(rule({ staffId: "b1" }))).toBe("barber");
    expect(ruleTarget(rule({ roleId: "r" }))).toBe("role");
    expect(ruleTarget(rule({ shopId: "s" }))).toBe("location");
  });
});

describe("rebook timing", () => {
  it("uses the client's cadence, then the service's interval, then the brand's, within 7 to 182 days", () => {
    expect(rebookInterval({ cadenceDays: 20.6, serviceDays: 42, defaultDays: 28 })).toEqual({ days: 21, source: "client" });
    expect(rebookInterval({ cadenceDays: null, serviceDays: 42, defaultDays: 28 })).toEqual({ days: 42, source: "service" });
    expect(rebookInterval({ cadenceDays: undefined, serviceDays: null, defaultDays: 28 })).toEqual({ days: 28, source: "brand" });
    expect(rebookInterval({ cadenceDays: 2, serviceDays: null, defaultDays: 28 }).days).toBe(7);
    expect(rebookInterval({ cadenceDays: 400, serviceDays: null, defaultDays: 28 }).days).toBe(182);
  });

  it("looks nearest the target first, later before earlier, never before tomorrow", () => {
    expect(candidateDays("2026-11-20", "2026-10-25", 2)).toEqual(["2026-11-20", "2026-11-21", "2026-11-19", "2026-11-22", "2026-11-18"]);
    expect(candidateDays("2026-10-26", "2026-10-25", 3)).toEqual(["2026-10-26", "2026-10-27", "2026-10-25", "2026-10-28", "2026-10-29"]);
    // An overdue client: look forward from tomorrow.
    expect(candidateDays("2026-10-01", "2026-10-25", 2)).toEqual(["2026-10-25", "2026-10-26", "2026-10-27"]);
  });

  it("offers one time a day nearest the time they came in, then more on the same days, sorted", () => {
    const day = (date: string, minutes: number[]) => ({ date, options: minutes.map((m) => ({ id: `${date}@${m}`, minute: m })) });
    const days = [day("2026-11-20", [540, 600, 840]), day("2026-11-21", [870, 900]), day("2026-11-19", [600])];
    expect(pickTimes(days, 855, 3).map((x) => x.id)).toEqual(["2026-11-19@600", "2026-11-20@840", "2026-11-21@870"]);
    expect(pickTimes(days, 855, 2).map((x) => x.id)).toEqual(["2026-11-20@840", "2026-11-21@870"]);
    expect(pickTimes([day("2026-11-20", [540, 600, 840])], 600, 3).map((x) => x.minute)).toEqual([540, 600, 840]);
    expect(pickTimes([], 600, 3)).toEqual([]);
  });

  it("sends the reminder lead days before they're due, never sooner than tomorrow", () => {
    expect(reminderDay("2026-11-20", 3, "2026-10-24")).toBe("2026-11-17");
    expect(reminderDay("2026-10-26", 3, "2026-10-24")).toBe("2026-10-25");
  });
});

describe("product suggestions", () => {
  const carried = new Set(["used", "mapA", "mapB", "past1", "past2"]);

  it("ranks used, then the service's in order, then past purchases by count and recency, once each with every reason", () => {
    const picks = rankProducts({
      used: ["used", "notCarried"],
      mapped: [
        { productId: "mapB", sortOrder: 20 },
        { productId: "mapA", sortOrder: 10 },
        { productId: "used", sortOrder: 5 },
      ],
      past: [
        { productId: "past2", times: 1, lastAt: "2026-09-01" },
        { productId: "past1", times: 3, lastAt: "2026-01-01" },
        { productId: "mapA", times: 2, lastAt: "2026-08-01" },
      ],
      carried,
      max: 8,
    });
    expect(picks).toEqual([
      { productId: "used", sources: ["used", "service"] },
      { productId: "mapA", sources: ["service", "past"] },
      { productId: "mapB", sources: ["service"] },
      { productId: "past1", sources: ["past"] },
      { productId: "past2", sources: ["past"] },
    ]);
    expect(rankProducts({ used: ["used"], mapped: [{ productId: "mapA", sortOrder: 1 }], past: [], carried, max: 1 })).toHaveLength(1);
  });

  it("calls stock out, low at the reorder point, or in stock", () => {
    expect(stockStatus(0, 3)).toBe("out");
    expect(stockStatus(-2, 3)).toBe("out");
    expect(stockStatus(3, 3)).toBe("low");
    expect(stockStatus(4, 3)).toBe("in_stock");
  });
});

describe("answers", () => {
  it("holds payment for a required prompt with no answer, unless the client has since booked", () => {
    const rows = [
      { prompt: "rebook" as const, required: true, outcome: null },
      { prompt: "product" as const, required: true, outcome: null },
      { prompt: "product" as const, required: false, outcome: null },
    ];
    expect(unansweredRequired(rows, { booked: false })).toEqual(["rebook", "product"]);
    expect(unansweredRequired(rows, { booked: true })).toEqual(["product"]);
    expect(unansweredRequired([{ prompt: "rebook", required: true, outcome: "declined" }], { booked: false })).toEqual([]);
    expect(requiredMessage(["rebook", "product"])).toBe("Answer the rebook prompt and the product suggestions before taking payment.");
  });

  it("takes no reason or one from the brand's list", () => {
    expect(reasonProblem(null, DEFAULT_REASONS)).toBeNull();
    expect(reasonProblem("Traveling", DEFAULT_REASONS)).toBeNull();
    expect(reasonProblem("Because", DEFAULT_REASONS)).toMatch(/Pick one/);
  });
});

describe("wiring", () => {
  const migration = readFileSync("drizzle/core_0062_checkout_prompts.sql", "utf8");

  it("logs prompt.shown, prompt.accepted and prompt.declined", () => {
    for (const e of ["prompt.shown", "prompt.accepted", "prompt.declined"]) expect(EVENTS).toHaveProperty(e);
  });

  it("has a brand-only settings permission and a report by location and barber, granted where the KPIs are", () => {
    expect(BRAND_ONLY.has("checkout_prompts.manage")).toBe(true);
    const r = REPORTS.find((x) => x.key === "checkout_prompts")!;
    expect(r.href).toBe("/admin/reports/checkout-prompts");
    expect(PAGE_ACCESS["/admin/checkout-prompts"]).toEqual(["checkout_prompts.manage"]);
    expect(pageAllowed(new Set(["checkout_prompts.manage"]), "/admin/checkout-prompts")).toBe(true);
    for (const key of ["regional_manager", "shop_manager", "shop_login"]) expect(templateFor(key)!.permissions, key).toContain(reportView("checkout_prompts"));
    expect(templateFor("brand_admin")!.permissions).toContain("checkout_prompts.manage");
    expect(templateFor("barber")!.permissions).not.toContain(reportView("checkout_prompts"));
    expect(migration).toContain(`'["${reportView("checkout_prompts")}"]'`);
    expect(migration).toContain(`'["${reportExport("checkout_prompts")}"]'`);
  });

  it("has an editable rebook reminder that keeps the booking link and isn't marketing", () => {
    expect(TEMPLATE_DEFS.rebook_reminder.body).toContain("{book_link}");
    expect("marketing" in TEMPLATE_DEFS.rebook_reminder).toBe(false);
    expect(templateProblem("rebook_reminder", { body: "Hi {first_name}, book: {book_link}" })).toBeNull();
  });

  it("is additive, and scrubs the decline reason like every other free-text column", () => {
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|ALTER COLUMN|RENAME/i);
    expect(migration).toMatch(/CREATE TRIGGER "checkout_prompts_scrub_sensitive"[^;]+scrub_sensitive_row"\('decline_reason'\)/);
  });
});
