import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Mods, actor, loadModules } from "./setup";

let m: Mods;
let V: typeof import("@/server/report-views-saved");

beforeAll(async () => {
  m = await loadModules();
  V = await import("@/server/report-views-saved");
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);

describe("saved report views", () => {
  it("keeps only report filters, replaces a view saved under the same name, and shows shared views to others", async () => {
    const people = await m.db.db.select({ id: m.schema.staff.id }).from(m.schema.staff).limit(2);
    const [me, other] = people.map((p) => ({ ...actor, staffId: p.id }));
    const v = await V.saveReportView({ report: "analytics", name: " Coralville  MTD ", query: "?preset=month&shop=abc&type=x&Bad-Key=1", shared: false, actor: me });
    expect(v).toMatchObject({ name: "Coralville MTD", query: "preset=month&shop=abc" });
    const again = await V.saveReportView({ report: "analytics", name: "coralville mtd", query: "preset=quarter", shared: true, actor: me });
    expect(again.id).toBe(v.id);
    expect((await V.listReportViews(me.staffId, "analytics")).map((x) => [x.name, x.query, x.mine])).toContainEqual(["coralville mtd", "preset=quarter", true]);
    expect((await V.listReportViews(other.staffId, "analytics")).find((x) => x.id === v.id)).toMatchObject({ mine: false, shared: true });
    expect(await V.listReportViews(other.staffId, "sales_summary")).toEqual([]);
    await expect(V.deleteReportView(v.id, other)).rejects.toMatchObject({ code: "forbidden" });
    await V.deleteReportView(v.id, me);
    expect(await m.db.db.query.reportViews.findFirst({ where: eq(m.schema.reportViews.id, v.id) })).toBeUndefined();
    const log = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.entityId, v.id));
    expect(log.map((l) => l.action).sort()).toEqual(["report_view.create", "report_view.delete", "report_view.update"]);
  });

  it("needs a name", async () => {
    const [p] = await m.db.db.select({ id: m.schema.staff.id }).from(m.schema.staff).limit(1);
    await expect(V.saveReportView({ report: "analytics", name: "  ", query: "", shared: false, actor: { ...actor, staffId: p.id } })).rejects.toMatchObject({ code: "bad_request" });
  });
});
