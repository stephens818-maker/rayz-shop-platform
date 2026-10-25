import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { brandSettings, services, staff, staffMilestoneBaselines, staffMilestoneRules } from "@/db/schema";
import { BirthdayInput, COUNT_METRICS, CUSTOM_KINDS, MilestoneSettings, RuleInput, cleanThresholds, ruleProblem } from "@/domain/milestones";
import { isValidLocalDate, todayLocal } from "@/lib/time";
import { audit } from "../audit";
import { type StaffContext, assertCan } from "../auth/staff";
import { AppError, forbidden, notFound } from "../errors";
import { loadMilestoneSettings } from "./engine";

export async function saveMilestoneSettings(ctx: StaffContext, raw: unknown) {
  assertCan(ctx, "milestones.settings");
  const parsed = MilestoneSettings.safeParse(raw);
  if (!parsed.success) throw new AppError("bad_request", parsed.error.issues[0]?.message ?? "Check the milestone settings");
  await db.update(brandSettings).set({ milestones: parsed.data, updatedAt: new Date() });
  await audit(ctx.actor, "settings.milestones", "brand_settings", "milestones", parsed.data, null);
  return parsed.data;
}

export async function saveRule(ctx: StaffContext, raw: unknown) {
  assertCan(ctx, "milestones.settings");
  const r = RuleInput.parse(raw);
  const thresholds = cleanThresholds(r.thresholds);
  const before = r.id ? await db.query.staffMilestoneRules.findFirst({ where: eq(staffMilestoneRules.id, r.id) }) : null;
  if (r.id && !before) throw notFound("Milestone");
  if (before?.builtIn && (before.kind !== r.kind || before.metric !== r.metric)) throw new AppError("bad_request", "A built-in milestone always counts the same thing; add your own to count something else");
  if (!before && !CUSTOM_KINDS.includes(r.kind)) throw new AppError("bad_request", "Personal bests and birthdays are built in; you can turn them on or off");
  const problem = ruleProblem({ ...r, thresholds });
  if (problem) throw new AppError("bad_request", problem);
  if (r.serviceIds.length) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(services).where(sql`${services.id} in (${sql.join(r.serviceIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    if (n !== new Set(r.serviceIds).size) throw new AppError("bad_request", "Pick services from the catalog");
  }
  const values = { kind: r.kind, metric: r.metric, name: r.name, unit: r.unit || null, thresholds, serviceIds: [...new Set(r.serviceIds)], active: r.active, updatedAt: new Date() };
  const id = await db.transaction(async (tx) => {
    let id = r.id;
    if (id) await tx.update(staffMilestoneRules).set(values).where(eq(staffMilestoneRules.id, id));
    else id = (await tx.insert(staffMilestoneRules).values({ ...values, createdBy: ctx.staff.id }).returning({ id: staffMilestoneRules.id }))[0].id;
    await audit(ctx.actor, r.id ? "milestones.rule_update" : "milestones.rule_create", "staff_milestone_rule", id, { name: r.name, kind: r.kind, metric: r.metric, thresholds, serviceIds: values.serviceIds, active: r.active }, null, tx);
    return id;
  });
  return { id };
}

export async function deleteRule(ctx: StaffContext, id: string) {
  assertCan(ctx, "milestones.settings");
  const r = await db.query.staffMilestoneRules.findFirst({ where: eq(staffMilestoneRules.id, id) });
  if (!r) throw notFound("Milestone");
  if (r.builtIn) throw new AppError("bad_request", "Built-in milestones can be turned off but not removed");
  await db.transaction(async (tx) => {
    await tx.delete(staffMilestoneRules).where(eq(staffMilestoneRules.id, id));
    await audit(ctx.actor, "milestones.rule_delete", "staff_milestone_rule", id, { name: r.name }, null, tx);
  });
}

const BaselineInput = z.object({
  staffId: z.uuid(),
  metric: z.enum(COUNT_METRICS),
  count: z.number().int().min(0, "Totals start at 0").max(1_000_000, "Totals go up to 1,000,000"),
  asOf: z.string().refine(isValidLocalDate, "Pick the date the total is as of"),
});

/** A person's Squire total from before the history in the system; history from as_of on counts on top. */
export async function saveBaseline(ctx: StaffContext, raw: unknown) {
  assertCan(ctx, "milestones.settings");
  const b = BaselineInput.parse(raw);
  if (b.asOf > todayLocal()) throw new AppError("bad_request", "The total can't be as of a date in the future");
  const person = await db.query.staff.findFirst({ where: eq(staff.id, b.staffId), columns: { kind: true } });
  if (!person || person.kind !== "person") throw notFound("Staff member");
  await db.transaction(async (tx) => {
    await tx
      .insert(staffMilestoneBaselines)
      .values({ ...b, setBy: ctx.staff.id })
      .onConflictDoUpdate({ target: [staffMilestoneBaselines.staffId, staffMilestoneBaselines.metric], set: { count: b.count, asOf: b.asOf, setBy: ctx.staff.id, updatedAt: new Date() } });
    await audit(ctx.actor, "milestones.baseline", "staff", b.staffId, { metric: b.metric, count: b.count, asOf: b.asOf }, null, tx);
  });
}

export async function deleteBaseline(ctx: StaffContext, staffId: string, metric: string) {
  assertCan(ctx, "milestones.settings");
  await db.transaction(async (tx) => {
    const got = await tx
      .delete(staffMilestoneBaselines)
      .where(and(eq(staffMilestoneBaselines.staffId, staffId), eq(staffMilestoneBaselines.metric, metric)))
      .returning({ id: staffMilestoneBaselines.staffId });
    if (!got.length) throw notFound("Squire total");
    await audit(ctx.actor, "milestones.baseline_delete", "staff", staffId, { metric }, null, tx);
  });
}

const PrefsInput = z.object({ birthday: BirthdayInput.optional(), shared: z.boolean().optional() });

/** Their own birthday (month and day only) and whether their milestones show in the team feed. */
export async function saveMyMilestonePrefs(ctx: StaffContext, raw: unknown) {
  if (ctx.staff.kind !== "person") throw forbidden("Milestones are for people; sign in as yourself");
  const p = PrefsInput.safeParse(raw);
  if (!p.success) throw new AppError("bad_request", p.error.issues[0]?.message ?? "Check the date");
  const s = await loadMilestoneSettings();
  const set: Partial<typeof staff.$inferInsert> = {};
  if (p.data.birthday !== undefined) {
    if (!s.birthdays && p.data.birthday) throw new AppError("conflict", "The brand hasn't turned birthdays on");
    set.birthdayMonth = p.data.birthday?.month ?? null;
    set.birthdayDay = p.data.birthday?.day ?? null;
  }
  if (p.data.shared !== undefined) set.milestonesShared = p.data.shared;
  if (!Object.keys(set).length) return;
  await db.transaction(async (tx) => {
    await tx.update(staff).set(set).where(eq(staff.id, ctx.staff.id));
    await audit(ctx.actor, "staff.milestone_prefs", "staff", ctx.staff.id, { birthday: p.data.birthday === undefined ? undefined : p.data.birthday ? "set" : "removed", shared: p.data.shared }, null, tx);
  });
}
