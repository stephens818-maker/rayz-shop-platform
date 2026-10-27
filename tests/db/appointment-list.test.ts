/**
 * The calendar's list view: a shop's appointments over one or seven days, by barber and status,
 * with names masked as on the calendar, and a barber who can't see every column sees only their own.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { signInAs } from "./session";
import { open } from "./render";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let list: typeof import("@/server/appointment-list");
const ids: Record<string, string> = {};
let coralville: string;
let busy: string;
type Row = import("@/server/appointment-list").ListedAppointment;

const rows = async <T>(q: ReturnType<Mods["drizzle"]["sql"]>) => (await m.db.db.execute(q)) as unknown as T[];
const sql = (...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a);
const FULL = { show: (_f: string, v: string | null | undefined) => v ?? null };

beforeAll(async () => {
  m = await loadModules();
  list = await import("@/server/appointment-list");
  for (const k of ["owner", "michelle", "makenna"])
    ids[k] = (await m.db.db.query.staff.findFirst({ where: m.drizzle.eq(m.schema.staff.email, `${k}@rayz.test`) }))!.id;
  coralville = (await m.db.db.query.shops.findFirst({ where: m.drizzle.eq(m.schema.shops.slug, "coralville") }))!.id;
  [{ d: busy }] = await rows<{ d: string }>(sql`
    select to_char((starts_at at time zone 'America/Chicago')::date, 'YYYY-MM-DD') d from appointments
    where shop_id = ${coralville} group by 1 order by count(*) desc limit 1`);
});

const countSql = async (from: string, days: number, extra = sql``) =>
  (
    await rows<{ n: number }>(sql`select count(*)::int n from appointments where shop_id = ${coralville}
      and (starts_at at time zone 'America/Chicago')::date between ${from}::date and ${from}::date + ${days - 1}::int ${extra}`)
  )[0].n;

describe("the appointment list", () => {
  it("lists a day's or a week's appointments in start order, filtered by barber and status", async () => {
    const day = await list.loadAppointmentList(coralville, busy as never, 1, { staffId: null, status: "all", privacy: FULL });
    expect(day.rows.length).toBeGreaterThan(0);
    expect(day.rows.length).toBe(await countSql(busy, 1));
    expect(day.rows.every((r, i) => i === 0 || day.rows[i - 1].date < r.date || (day.rows[i - 1].date === r.date && day.rows[i - 1].startMin <= r.startMin))).toBe(true);
    const week = await list.loadAppointmentList(coralville, busy as never, 7, { staffId: null, status: "all", privacy: FULL });
    expect(week.rows.length).toBe(await countSql(busy, 7));
    const done = await list.loadAppointmentList(coralville, busy as never, 7, { staffId: null, status: "completed", privacy: FULL });
    expect(done.rows.length).toBe(await countSql(busy, 7, sql`and status = 'completed'`));
    expect(done.rows.every((r) => r.status === "completed")).toBe(true);
    const missed = await list.loadAppointmentList(coralville, busy as never, 7, { staffId: null, status: "missed", privacy: FULL });
    expect(missed.rows.every((r) => r.status === "cancelled" || r.status === "no_show")).toBe(true);
    const one = day.rows[0].staffId;
    const mine = await list.loadAppointmentList(coralville, busy as never, 7, { staffId: one, status: "all", privacy: FULL });
    expect(mine.rows.length).toBe(await countSql(busy, 7, sql`and staff_id = ${one}`));
  });

  it("masks last names as the calendar does", async () => {
    const masked = { show: (f: string, v: string | null | undefined) => (f === "last_name" && v ? `${v.charAt(0)}.` : (v ?? null)) };
    const r = await list.loadAppointmentList(coralville, busy as never, 7, { staffId: null, status: "all", privacy: masked });
    const named = r.rows.filter((x) => x.customerId);
    expect(named.length).toBeGreaterThan(0);
    const last = new Map(
      (await m.db.db.select({ id: m.schema.customers.id, last: m.schema.customers.lastName }).from(m.schema.customers).where(m.drizzle.inArray(m.schema.customers.id, named.map((x) => x.customerId!)))).map((c) => [c.id, c.last]),
    );
    for (const x of named) {
      const l = last.get(x.customerId!);
      if (l && l.length > 1) expect(x.customerName).not.toContain(l);
    }
  });

  it("opens as a calendar view: a barber sees only their own appointments, a manager picks a barber", async () => {
    const seen: { rows?: Row[]; barbers?: unknown } = {};
    const grab = (type: unknown, props: Record<string, unknown>) => {
      if ((type as { name?: string })?.name === "AppointmentList") Object.assign(seen, props);
    };
    await signInAs(ids.makenna, coralville);
    const own = await open("/admin/calendar", {}, { view: "list", date: busy, days: "7", staff: ids.michelle }, grab);
    expect(own.kind).toBe("ok");
    expect(seen.barbers).toBeNull();
    expect(seen.rows!.every((r) => r.staffId === ids.makenna)).toBe(true);
    await signInAs(ids.michelle, coralville);
    const mgr = await open("/admin/calendar", {}, { view: "list", date: busy, days: "7" }, grab);
    expect(mgr.kind).toBe("ok");
    expect(Array.isArray(seen.barbers)).toBe(true);
    expect(seen.rows!.length).toBe(await countSql(busy, 7));
  });
});
