/**
 * The brand's time format (Charles: no military time). 12-hour with AM and PM by default on every
 * screen, the timesheets and the staff app's config; 24-hour only if the brand picks it. Payroll
 * hours read decimal (the workbook) or as hours and minutes. Times stay UTC instants in the database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { brandSettings } from "./brand";
import { Mods, loadModules } from "./setup";
import { signInAs } from "./session";
import { open } from "./render";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let tc: typeof import("@/server/time-clock");
let display: typeof import("@/server/display");
let settings: typeof import("@/server/brand-sync/settings");
let hours: typeof import("@/lib/hours");

beforeAll(async () => {
  m = await loadModules();
  tc = await import("@/server/time-clock");
  display = await import("@/server/display");
  settings = await import("@/server/brand-sync/settings");
  hours = await import("@/lib/hours");
}, 180_000);

afterAll(async () => {
  await brandSettings({ time_format: "12h", "display.payroll_hours": "decimal" }).catch(() => {});
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const S = () => m.schema;
const staffBy = async (email: string) => (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, email) }))!;
const shop = async (slug: string) => (await m.db.db.query.shops.findFirst({ where: eq(S().shops.slug, slug) }))!;
const at = (date: string, min: number) => m.time.zonedWallTime(date, min).toJSDate();
const HERE = { lat: 41.6767, lng: -91.5811, accuracyM: 10 };

async function punchAt(staff: { id: string; displayLabel: string }, shopId: string, type: "in" | "out", now: Date) {
  const r = await tc.punch({ staffId: staff.id, shopId, type, source: "self", evidence: { deviceShopId: null, ip: null, gps: HERE }, deviceId: null, photo: null, actor: { staffId: staff.id, label: staff.displayLabel }, now });
  if (r.kind !== "done") throw new Error(r.message);
}

describe("the brand's time format", () => {
  it("is 12-hour by default: timesheets, the staff app's config and the stored setting", async () => {
    const mk = await staffBy("makenna@rayz.test");
    const cv = await shop("coralville");
    const day = m.time.addDays(m.time.todayLocal(), -30);
    await punchAt(mk, cv.id, "in", at(day, 9 * 60 + 5));
    await punchAt(mk, cv.id, "out", at(day, 17 * 60 + 30));
    const stored = await m.db.db
      .select({ at: S().timePunches.at })
      .from(S().timePunches)
      .where(m.drizzle.and(eq(S().timePunches.staffId, mk.id), m.drizzle.gte(S().timePunches.at, m.time.startOfLocalDay(day)), m.drizzle.lt(S().timePunches.at, m.time.endOfLocalDay(day))))
      .orderBy(S().timePunches.at);
    expect(stored.map((r) => r.at.toISOString())).toEqual([at(day, 9 * 60 + 5).toISOString(), at(day, 17 * 60 + 30).toISOString()]);

    expect(await settings.settingAt("time_format")).toBe("12h");
    expect((await display.loadDisplay()).timeFormat).toBe("12h");
    await signInAs((await staffBy("owner@rayz.test")).id);
    const period = (await tc.periodFor(day)).start;
    const page = await open("/admin/timesheets/[staffId]", { staffId: mk.id }, { period });
    expect(page.kind).toBe("ok");
    expect(page.text).toContain("9:05 AM – 5:30 PM");
    expect(page.text).not.toMatch(/\b17:30\b/);

    const { staffAppConfig } = await import("@/server/staff-api/config");
    expect(staffAppConfig(new Request("http://localhost/api/staff/v1/config")).display).toEqual({ timeFormat: "12h", timePattern: "h:mm a", example: "5:30 PM", timeZone: "America/Chicago", payrollHours: "decimal" });
  });

  it("switches to 24-hour only when the brand picks it, and back", async () => {
    await brandSettings({ time_format: "24h" });
    const [row] = await m.db.db.select({ f: S().brandSettings.timeFormat, d: S().brandSettings.display }).from(S().brandSettings);
    expect(row.f).toBe("24h");
    expect(row.d).not.toHaveProperty("timeFormat");
    expect(await (await import("@/server/brand-time")).brandTimeFormat()).toBe("24h");
    expect(await (await import("@/server/brand-time")).formatForHumans(at("2026-10-27", 17 * 60 + 30))).toBe("Tue, Oct 27 · 17:30");
    expect((await display.loadDisplay()).timeFormat).toBe("24h");
    expect(m.time.formatTime(at("2026-10-27", 17 * 60 + 30))).toBe("17:30");
    const { staffAppConfig } = await import("@/server/staff-api/config");
    expect(staffAppConfig(new Request("http://localhost/api/staff/v1/config")).display).toMatchObject({ timeFormat: "24h", timePattern: "HH:mm", example: "17:30" });

    await brandSettings({ time_format: "12h" });
    expect((await display.loadDisplay()).timeFormat).toBe("12h");
    expect(m.time.formatTime(at("2026-10-27", 17 * 60 + 30))).toBe("5:30 PM");
  });

  it("refuses a format it doesn't know", async () => {
    await expect(brandSettings({ time_format: "military" })).rejects.toThrow(/12-hour or 24-hour/);
    await expect(brandSettings({ "display.payroll_hours": "minutes" })).rejects.toThrow(/decimal hours or hours and minutes/);
    await expect(m.db.db.execute(m.drizzle.sql`update brand_settings set time_format = 'military'`)).rejects.toThrow();
    expect(await settings.settingAt("time_format")).toBe("12h");
  });

  it("payroll hours read decimal by default, or as hours and minutes, and the two settings keep each other", async () => {
    expect(await settings.settingAt("display.payroll_hours")).toBe("decimal");
    await brandSettings({ "display.payroll_hours": "hm" });
    expect((await display.loadDisplay()).payrollHours).toBe("hm");
    expect(hours.formatPayHours(8.5)).toBe("8h 30m");
    const { fmtHours } = await import("@/domain/payroll/calc");
    expect(fmtHours(2)).toBe("2h");
    expect(fmtHours(7.75)).toBe("7h 45m");
    expect(await settings.settingAt("time_format")).toBe("12h");

    await brandSettings({ "display.payroll_hours": "decimal" });
    expect((await display.loadDisplay()).payrollHours).toBe("decimal");
    expect(hours.formatPayHours(8.5)).toBe("8.50");
    expect(fmtHours(7.75)).toBe("7.75h");
  });
});
