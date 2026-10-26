import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import { markNewListItem, offeredAt } from "./brand-sync/lists";
import { settingAt } from "./brand-sync/settings";
import { payrollRates, payrollRuns, services, staff, staffCompensation, staffCustomFields, staffCustomValues, staffShops } from "@/db/schema";
import {
  NO_RATES,
  blendedHourly,
  commissionBetween,
  guaranteeForDays,
  lineRate,
  monthStart,
  fieldProblem,
  fieldValue,
  sortVersions,
  versionOn,
  versionProblem,
  type BaseRates,
  type CommissionLine,
  type CompVersion,
  type CompensationSettings,
  type Fallback,
  type FieldKind,
  type VersionInput,
} from "@/domain/compensation";
import type { BrandTipPolicy, TipMethod } from "@/domain/tips";
import type { DayHours } from "@/domain/payroll/overtime";
import { diffDays, todayLocal, type LocalDate } from "@/lib/time";
import { audit, type Actor } from "@/server/audit";
import { AppError, forbidden, notFound } from "@/server/errors";
import { PAID, rows, uuids } from "@/server/report-sql";
import type { StaffContext } from "@/server/auth/staff";

// ───────────────────────────── Settings ─────────────────────────────

/** The compensation fields (the compensation setting): one for the whole brand. */
export const loadCompensationSettings = (tx: DBorTx = db): Promise<CompensationSettings> => settingAt<CompensationSettings>("compensation", null, tx);

// ───────────────────────────── Who sees whose ─────────────────────────────

/**
 * Compensation is the brand's by default: Brand Owner and Brand Admin have it, and the brand can
 * give "See compensation" or "Edit compensation" to any role or person. Someone limited to some
 * shops sees the people who work at one of them, and edits only people who work at none outside
 * them (a plan covers every shop the person works at). Nobody edits their own; their own pay is
 * on My pay, with "See their own pay".
 */
export async function compensationAccess(ctx: Pick<StaffContext, "permissions" | "brandWide" | "shopIds" | "staff">, staffId: string): Promise<{ view: boolean; edit: boolean; shopIds: string[] }> {
  const shopIds = (await db.select({ id: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, staffId))).map((r) => r.id);
  const [p] = await db.select({ kind: staff.kind }).from(staff).where(eq(staff.id, staffId));
  if (!p || p.kind !== "person" || staffId === ctx.staff.id) return { view: false, edit: false, shopIds };
  const mine = ctx.brandWide || shopIds.some((id) => ctx.shopIds.includes(id));
  const all = ctx.brandWide || (shopIds.length > 0 && shopIds.every((id) => ctx.shopIds.includes(id)));
  const view = mine && (ctx.permissions.has("compensation.view") || ctx.permissions.has("compensation.edit"));
  return { view, edit: view && all && ctx.permissions.has("compensation.edit"), shopIds };
}

// ───────────────────────────── Versions ─────────────────────────────

type VersionRow = typeof staffCompensation.$inferSelect;

export const toVersion = (r: VersionRow): CompVersion & { id: string; staffId: string; createdBy: string | null } => ({
  id: r.id,
  staffId: r.staffId,
  createdBy: r.createdBy,
  effectiveFrom: r.effectiveFrom,
  createdAt: r.createdAt,
  hourlyRateCents: r.hourlyRateCents,
  shopHourlyRates: r.shopHourlyRates ?? [],
  servicePct: r.servicePct,
  serviceOverrides: r.serviceOverrides ?? [],
  serviceTiers: r.serviceTiers ?? [],
  tierMode: r.tierMode,
  productPct: r.productPct,
  boothRentCents: r.boothRentCents,
  boothRentFrequency: r.boothRentFrequency,
  guaranteeCents: r.guaranteeCents,
  guaranteePer: r.guaranteePer,
  tipMethod: r.tipMethod,
  tipCardFeeNetting: r.tipCardFeeNetting,
  note: r.note,
});

export type StoredVersion = ReturnType<typeof toVersion>;

/** Every version per employee, newest first (sortVersions). */
export async function versionsFor(staffIds: readonly string[], tx: DBorTx = db): Promise<Map<string, StoredVersion[]>> {
  const out = new Map<string, StoredVersion[]>();
  if (!staffIds.length) return out;
  const list = await tx.select().from(staffCompensation).where(inArray(staffCompensation.staffId, [...staffIds]));
  for (const r of list) out.set(r.staffId, [...(out.get(r.staffId) ?? []), toVersion(r)]);
  for (const [k, v] of out) out.set(k, sortVersions(v));
  return out;
}

/** The last day of the latest locked pay period: a change can't start on or before it. */
export async function lockedThrough(tx: DBorTx = db): Promise<LocalDate | null> {
  const [r] = await tx.select({ end: sql<string | null>`max(${payrollRuns.periodEnd})::text` }).from(payrollRuns);
  return r?.end ?? null;
}

export async function versionContext(staffId: string, now = new Date()) {
  const [shopIds, svc, policy, locked] = await Promise.all([
    db.select({ id: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, staffId)),
    db.select({ id: services.id, category: services.category }).from(services),
    settingAt<BrandTipPolicy>("tip_payouts"),
    lockedThrough(),
  ]);
  return {
    today: todayLocal(now),
    lockedThrough: locked,
    shopIds: shopIds.map((s) => s.id),
    serviceIds: svc.map((s) => s.id),
    categories: [...new Set(svc.map((s) => s.category))],
    tipMethods: policy.methods,
  };
}

export async function addVersion(staffId: string, v: VersionInput, actor: Actor, now = new Date()) {
  const problem = versionProblem(v, await versionContext(staffId, now));
  if (problem) throw new AppError("bad_request", problem);
  const [row] = await db
    .insert(staffCompensation)
    .values({ ...v, staffId, createdBy: actor.staffId ?? null })
    .returning();
  await audit(actor, "compensation.version_add", "staff", staffId, { versionId: row.id, ...versionDetails(v) });
  return toVersion(row);
}

/** Only a version that hasn't started yet can be withdrawn; the database refuses the rest too. */
export async function deleteVersion(staffId: string, versionId: string, actor: Actor, now = new Date()) {
  const [row] = await db.select().from(staffCompensation).where(and(eq(staffCompensation.id, versionId), eq(staffCompensation.staffId, staffId)));
  if (!row) throw notFound("Compensation version");
  if (row.effectiveFrom <= todayLocal(now)) throw new AppError("bad_request", "This version has already taken effect, so it stays in the history. Add a new version to change it.");
  await db.delete(staffCompensation).where(eq(staffCompensation.id, versionId));
  await audit(actor, "compensation.version_delete", "staff", staffId, { versionId, ...versionDetails(toVersion(row)) });
}

/** What the audit log keeps of a version: everything but the note's text. */
const versionDetails = (v: VersionInput) => ({
  effectiveFrom: v.effectiveFrom,
  hourlyRateCents: v.hourlyRateCents,
  shopHourlyRates: v.shopHourlyRates,
  servicePct: v.servicePct,
  serviceOverrides: v.serviceOverrides,
  serviceTiers: v.serviceTiers,
  tierMode: v.tierMode,
  productPct: v.productPct,
  boothRentCents: v.boothRentCents,
  boothRentFrequency: v.boothRentFrequency,
  guaranteeCents: v.guaranteeCents,
  guaranteePer: v.guaranteePer,
  tipMethod: v.tipMethod,
  tipCardFeeNetting: v.tipCardFeeNetting,
  hasNote: !!v.note,
});

// ───────────────────────────── Payroll setup's rates, the fallback ─────────────────────────────

/** Payroll setup's rates per employee, for whatever a plan leaves blank (and for anyone without one). */
export async function setupRates(staffIds: readonly string[], tx: DBorTx = db): Promise<(staffId: string) => Fallback> {
  const list = staffIds.length ? await tx.select().from(payrollRates).where(inArray(payrollRates.staffId, [...staffIds])) : [];
  return (staffId) => (shopId) => {
    const r = list.find((x) => x.staffId === staffId && x.shopId === shopId) ?? list.find((x) => x.staffId === staffId && x.shopId === null);
    return r ? ({ hourlyRate: r.hourlyRate, servicePct: r.servicePct, productPct: r.productPct } satisfies BaseRates) : NO_RATES;
  };
}

// ───────────────────────────── Sales lines ─────────────────────────────

/**
 * Every service, add-on and product line paid in [from, to], and every refund of one given in it,
 * per employee: the line's barber (the ticket's when the line has none). The same sales payroll
 * counts (Squire imports and tickets with no barber left out), so the service and product totals
 * here are payroll's. A refund not itemized by line counts against the ticket's barber.
 */
export async function commissionLines(staffIds: readonly string[] | null, from: LocalDate, to: LocalDate): Promise<Map<string, CommissionLine[]>> {
  const who = (col: SQL) => (staffIds ? sql` and ${col} in ${uuids([...staffIds])}` : sql``);
  const itemNet = sql`coalesce((e.value->>'netCents')::int, round(i.net_cents::numeric * coalesce((e.value->>'qty')::int, 0) / nullif(i.qty, 0))::int, 0)`;
  const items = sql`(case when jsonb_typeof(r.items) = 'array' then r.items else '[]'::jsonb end)`;
  const list = await rows<{ staff_id: string; date: string; sale_date: string; shop_id: string; kind: "service" | "product"; ref_id: string | null; category: string | null; gross: number; disc: number; refund: number; net: number }>(sql`
    select coalesce(i.staff_id, s.staff_id) staff_id, s.business_date::text date, s.business_date::text sale_date, s.shop_id,
      case when i.kind = 'product' then 'product' else 'service' end kind, i.ref_id, sv.category,
      i.gross_cents gross, i.discount_cents disc, 0 refund, i.net_cents net
    from sale_items i join sales s on s.id = i.sale_id
      left join services sv on sv.id = i.ref_id and i.kind in ('service', 'addon')
    where i.kind in ('service', 'addon', 'product') and s.status in ${PAID} and not s.is_imported and s.staff_id is not null
      and s.business_date between ${from} and ${to} ${who(sql`coalesce(i.staff_id, s.staff_id)`)}
    union all
    select coalesce(i.staff_id, s.staff_id), r.business_date::text, s.business_date::text, r.shop_id,
      case when i.kind = 'product' then 'product' else 'service' end, i.ref_id, sv.category, 0, 0, ${itemNet}, -${itemNet}
    from refunds r join sales s on s.id = r.sale_id
      cross join lateral jsonb_array_elements(${items}) e
      join sale_items i on i.id::text = e.value->>'saleItemId'
      left join services sv on sv.id = i.ref_id and i.kind in ('service', 'addon')
    where r.kind = 'refund' and not s.is_imported and s.staff_id is not null and i.kind in ('service', 'addon', 'product')
      and r.business_date between ${from} and ${to} ${who(sql`coalesce(i.staff_id, s.staff_id)`)}
    union all
    select s.staff_id, r.business_date::text, s.business_date::text, r.shop_id, k.kind, null, null, 0, 0, k.net, -k.net
    from refunds r join sales s on s.id = r.sale_id
      cross join lateral (
        select coalesce(sum(${itemNet}) filter (where i.kind in ('service', 'addon')), 0)::int svc, coalesce(sum(${itemNet}) filter (where i.kind = 'product'), 0)::int prod
        from jsonb_array_elements(${items}) e join sale_items i on i.id::text = e.value->>'saleItemId'
      ) itm
      cross join lateral (values ('service', r.service_net_cents - itm.svc), ('product', r.product_net_cents - itm.prod)) k(kind, net)
    where r.kind = 'refund' and not s.is_imported and s.staff_id is not null and k.net <> 0
      and r.business_date between ${from} and ${to} ${who(sql`s.staff_id`)}`);
  const out = new Map<string, CommissionLine[]>();
  for (const r of list) {
    const l: CommissionLine = { date: r.date, saleDate: r.sale_date, shopId: r.shop_id, kind: r.kind, refId: r.ref_id, category: r.category, grossCents: r.gross, discountCents: r.disc, refundCents: r.refund, netCents: r.net };
    out.set(r.staff_id, [...(out.get(r.staff_id) ?? []), l]);
  }
  return out;
}

// ───────────────────────────── Payroll ─────────────────────────────

export interface PayrollPlans {
  /** Null: no plan, so Payroll setup's rates. */
  rateFor(staffId: string, shopId: string): BaseRates | null;
  /** The guaranteed minimum for the period in dollars, or null. */
  guaranteeOf(staffId: string): number | null;
}

/**
 * What payroll takes from plans for one pay period (compensation on, and payroll set to use plans):
 * per employee and shop, the hourly rate (hours-weighted when it changed mid-period) and the
 * period's commission as rates, commission ÷ sales, so the report's Commission$ (E × G) and Product
 * Total (J × K) are what the plan earned, overrides and tiers included. Per employee, the guaranteed
 * minimum for the period. Anyone without a version keeps Payroll setup's rates and no guarantee.
 */
export async function payrollPlans(o: { staffIds: readonly string[]; start: LocalDate; end: LocalDate; days: readonly DayHours[]; fallbackOf: (staffId: string) => Fallback }): Promise<PayrollPlans> {
  const versions = await versionsFor(o.staffIds);
  const planned = o.staffIds.filter((id) => versions.get(id)?.length);
  const lines = planned.length ? await commissionLines(planned, monthStart(o.start), o.end) : new Map<string, CommissionLine[]>();
  const comm = new Map(planned.map((id) => [id, commissionBetween(lines.get(id) ?? [], versions.get(id)!, o.fallbackOf(id), o.start, o.end)]));
  const periodDays = diffDays(o.end, o.start) + 1;
  return {
    rateFor(staffId, shopId) {
      const vs = versions.get(staffId);
      if (!vs?.length) return null;
      const fb = o.fallbackOf(staffId);
      const v = versionOn(vs, o.end);
      const c = comm.get(staffId)?.get(shopId);
      const flat = lineRate(v, { kind: "service", refId: null, category: null, shopId }, fb);
      const days = o.days.filter((d) => d.staffId === staffId && d.shopId === shopId && d.date >= o.start && d.date <= o.end).map((d) => ({ date: d.date, centi: d.worked }));
      return {
        hourlyRate: blendedHourly(days, vs, shopId, fb, o.end),
        servicePct: c?.serviceNetCents ? c.serviceCommissionCents / c.serviceNetCents : flat.source === "tier" ? (v?.servicePct ?? fb(null).servicePct) : flat.pct,
        productPct: c?.productNetCents ? c.productCommissionCents / c.productNetCents : (v?.productPct ?? fb(shopId).productPct),
      };
    },
    guaranteeOf(staffId) {
      const v = versionOn(versions.get(staffId) ?? [], o.end);
      return v?.guaranteeCents != null && v.guaranteePer ? guaranteeForDays({ cents: v.guaranteeCents, per: v.guaranteePer }, periodDays, periodDays) / 100 : null;
    },
  };
}

// ───────────────────────────── Tips ─────────────────────────────

/**
 * How each employee's plan says their tips are paid, when compensation is on: a payout method that
 * beats their own choice and the shop's default (never a payroll-only shop's rule), and whether the
 * card fee comes out of their card tips. Null where the plan leaves it to the shop.
 */
export async function tipOverrides(staffIds: readonly string[], tx: DBorTx = db, now = new Date()): Promise<Map<string, { method: TipMethod | null; netCardFee: boolean | null }>> {
  const out = new Map<string, { method: TipMethod | null; netCardFee: boolean | null }>();
  if (!staffIds.length || !(await loadCompensationSettings(tx)).enabled) return out;
  const today = todayLocal(now);
  for (const [staffId, vs] of await versionsFor(staffIds, tx)) {
    const v = versionOn(vs, today);
    if (v && (v.tipMethod !== null || v.tipCardFeeNetting !== null)) out.set(staffId, { method: v.tipMethod, netCardFee: v.tipCardFeeNetting });
  }
  return out;
}

// ───────────────────────────── Custom employee fields ─────────────────────────────

/** With a shop, the fields that shop keeps. */
export async function customFields(
  o: { activeOnly?: boolean; shopId?: string | null } = {},
) {
  const list = await db.select().from(staffCustomFields).orderBy(asc(staffCustomFields.position), asc(staffCustomFields.label));
  return offeredAt(
    "staff_field",
    o.shopId,
    o.activeOnly ? list.filter((f) => f.active) : list,
  );
}

export async function saveCustomField(
  id: string | null,
  f: { label: string; kind: FieldKind; options: string[]; position: number },
  actor: Actor,
  ctx: StaffContext | null = null,
) {
  const all = await customFields();
  const current = id ? all.find((x) => x.id === id) : null;
  if (id && !current) throw notFound("Field");
  if (current && current.kind !== f.kind) throw new AppError("bad_request", "A field's type can't change once it's made; add a new field instead");
  const problem = fieldProblem(f, all.filter((x) => x.active && x.id !== id).map((x) => x.label));
  if (problem) throw new AppError("bad_request", problem);
  const values = { label: f.label.trim(), kind: f.kind, options: f.kind === "dropdown" ? f.options.map((o) => o.trim()) : [], position: Math.max(0, Math.min(1000, Math.round(f.position))) };
  if (current) {
    if (current.kind === "dropdown") {
      const gone = current.options.filter((o) => !values.options.some((n) => n.toLowerCase() === o.toLowerCase()));
      if (gone.length) {
        const [used] = await db.select({ n: sql<number>`count(*)::int` }).from(staffCustomValues).where(and(eq(staffCustomValues.fieldId, current.id), inArray(staffCustomValues.value, gone)));
        if (used.n) throw new AppError("bad_request", `"${gone[0]}" is picked for ${used.n} ${used.n === 1 ? "person" : "people"}; change theirs first`);
      }
    }
    await db.update(staffCustomFields).set({ ...values, updatedAt: new Date() }).where(eq(staffCustomFields.id, current.id));
    await audit(actor, "compensation.field_edit", "staff_custom_field", current.id, { before: { label: current.label, options: current.options }, after: values });
    return current.id;
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
    .insert(staffCustomFields)
    .values({ ...values, createdBy: actor.staffId ?? null })
    .returning({ id: staffCustomFields.id });
    await markNewListItem(tx, "staff_field", row.id, { actor, ctx });
    await audit(
      actor,
      "compensation.field_add",
      "staff_custom_field",
      row.id,
      values,
      null,
      tx,
    );
    return row.id;
  });
}

/** Retiring a field hides it everywhere and keeps the values already entered. */
export async function setCustomFieldActive(id: string, active: boolean, actor: Actor) {
  const [f] = await db.select().from(staffCustomFields).where(eq(staffCustomFields.id, id));
  if (!f) throw notFound("Field");
  if (active && (await customFields({ activeOnly: true })).some((x) => x.label.trim().toLowerCase() === f.label.trim().toLowerCase())) throw new AppError("conflict", `There's already a field called "${f.label}"`);
  await db.update(staffCustomFields).set({ active, updatedAt: new Date() }).where(eq(staffCustomFields.id, id));
  await audit(actor, active ? "compensation.field_restore" : "compensation.field_retire", "staff_custom_field", id, { label: f.label });
}

export async function customValues(staffId: string) {
  return db.select().from(staffCustomValues).where(eq(staffCustomValues.staffId, staffId));
}

/** Saves the values given (field id → raw text); a blank one clears it. Each change is logged with before and after. */
export async function saveCustomValues(staffId: string, raw: Record<string, string>, actor: Actor) {
  const fields = await customFields({ activeOnly: true });
  const before = new Map((await customValues(staffId)).map((v) => [v.fieldId, v.value]));
  const changes: { field: string; before: string | null; after: string | null }[] = [];
  const clean: { fieldId: string; value: string | null }[] = [];
  for (const [fieldId, text] of Object.entries(raw)) {
    const f = fields.find((x) => x.id === fieldId);
    if (!f) throw new AppError("bad_request", "That field was retired or doesn't exist; reload the page");
    const r = fieldValue(f, text);
    if ("error" in r) throw new AppError("bad_request", `${f.label}: ${r.error}`);
    if ((before.get(fieldId) ?? null) === r.value) continue;
    clean.push({ fieldId, value: r.value });
    changes.push({ field: f.label, before: before.get(fieldId) ?? null, after: r.value });
  }
  if (!clean.length) return 0;
  await db.transaction(async (tx) => {
    for (const c of clean) {
      if (c.value === null) await tx.delete(staffCustomValues).where(and(eq(staffCustomValues.staffId, staffId), eq(staffCustomValues.fieldId, c.fieldId)));
      else
        await tx
          .insert(staffCustomValues)
          .values({ staffId, fieldId: c.fieldId, value: c.value, updatedBy: actor.staffId ?? null })
          .onConflictDoUpdate({ target: [staffCustomValues.staffId, staffCustomValues.fieldId], set: { value: c.value, updatedBy: actor.staffId ?? null, updatedAt: new Date() } });
    }
    await audit(actor, "compensation.fields_set", "staff", staffId, { changes }, null, tx);
  });
  return clean.length;
}

export function assertEditable(a: { edit: boolean; view: boolean }) {
  if (!a.view) throw notFound("Staff member");
  if (!a.edit) throw forbidden("You can see this person's compensation but not change it");
}
