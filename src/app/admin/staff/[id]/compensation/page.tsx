import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { services, shops, staff } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { VERSION_STATUS_LABEL, describePlan, formatFieldValue, timeline, type CompVersion, type VersionStatus } from "@/domain/compensation";
import { METHOD_LABEL } from "@/domain/tips";
import { addDays, formatDate, formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { compensationAccess, customFields, customValues, loadCompensationSettings, setupRates, versionContext, versionsFor } from "@/server/compensation";
import { DeleteVersion, FieldValues, VersionEditor, type Draft } from "./client";

export const metadata: Metadata = { title: "Compensation" };

const STATUS_TONE: Record<VersionStatus, "green" | "blue" | "gray"> = { current: "green", scheduled: "blue", past: "gray", replaced: "gray" };
const pct = (f: number) => String(Math.round(f * 10000) / 100);
const money = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

function draftOf(v: CompVersion | null, effectiveFrom: string): Draft {
  return {
    effectiveFrom,
    hourly: money(v?.hourlyRateCents ?? null),
    shopHourly: Object.fromEntries((v?.shopHourlyRates ?? []).map((r) => [r.shopId, money(r.cents)])),
    servicePct: v?.servicePct == null ? "" : pct(v.servicePct),
    overrides: (v?.serviceOverrides ?? []).map((o) => ({ kind: o.kind, ref: o.ref, pct: pct(o.pct) })),
    tiers: (v?.serviceTiers ?? []).map((t) => ({ from: money(t.fromCents), pct: pct(t.pct) })),
    tierMode: v?.tierMode ?? "step",
    productPct: v?.productPct == null ? "" : pct(v.productPct),
    rent: money(v?.boothRentCents ?? null),
    rentFrequency: v?.boothRentFrequency ?? "",
    guarantee: money(v?.guaranteeCents ?? null),
    guaranteePer: v?.guaranteePer ?? "",
    tipMethod: v?.tipMethod ?? "",
    cardFee: v?.tipCardFeeNetting == null ? "" : v.tipCardFeeNetting ? "yes" : "no",
    note: "",
  };
}

export default async function StaffCompensationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await guardPage("/admin/staff/[id]/compensation");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const person = await db.query.staff.findFirst({ where: eq(staff.id, id) });
  if (!person) notFound();
  const access = await compensationAccess(ctx, id);
  if (!access.view) notFound();
  const settings = await loadCompensationSettings();
  const header = (
    <PageHeader
      title={`${person.displayLabel}: compensation`}
      subtitle="Pay plan history. Each change starts on a date and never rewrites pay already approved and locked."
      actions={
        <Link className="text-sm underline" href={`/admin/staff/${id}`}>
          Back to profile
        </Link>
      }
    />
  );
  if (!settings.enabled)
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        {header}
        <Empty title="Compensation fields are off">
          {can(ctx, "compensation.settings") ? (
            <>
              Turn them on in{" "}
              <Link className="underline" href="/admin/compensation">
                Compensation settings
              </Link>
              .
            </>
          ) : (
            "The brand hasn't turned them on."
          )}
        </Empty>
      </div>
    );

  const [vc, versions, fallbackOf, shopRows, serviceRows, fields, values] = await Promise.all([
    versionContext(id),
    versionsFor([id]).then((m) => m.get(id) ?? []),
    setupRates([id]),
    access.shopIds.length ? db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, access.shopIds)).orderBy(asc(shops.name)) : [],
    db.select({ id: services.id, name: services.name, category: services.category, active: services.active }).from(services).orderBy(asc(services.category), asc(services.name)),
    customFields({ activeOnly: true }),
    customValues(id),
  ]);
  const rows = timeline(versions, vc.today);
  const creators = rows.map((r) => r.createdBy).filter((x): x is string => !!x);
  const byName = new Map((creators.length ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, creators)) : []).map((s) => [s.id, s.label]));
  const shopName = (sid: string) => shopRows.find((s) => s.id === sid)?.name ?? "another shop";
  const serviceName = (sid: string) => serviceRows.find((s) => s.id === sid)?.name ?? "A removed service";
  const names = { shop: shopName, service: serviceName, tipMethod: (m: keyof typeof METHOD_LABEL) => METHOD_LABEL[m] };
  const current = rows.find((r) => r.status === "current") ?? null;
  const earliest = vc.lockedThrough ? addDays(vc.lockedThrough, 1) : addDays(vc.today, -365);
  const fb = fallbackOf(id)(null);
  const valueOf = new Map(values.map((v) => [v.fieldId, v.value]));

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {header}
      <Notice tone="blue">
        Only pay terms live here. Bank accounts, cards, SSNs and tax IDs stay with Stripe and iSolved and are never stored in this app.
        {!settings.payrollUsesPlans && " Payroll still uses Payroll setup's rates: the brand hasn't set payroll to use these plans yet."}
      </Notice>
      {!access.edit && <Notice tone="blue">You can see this person&apos;s compensation but not change it.</Notice>}
      <Card>
        <CardHeader title="In effect today" subtitle={current ? `Since ${formatDate(current.effectiveFrom, "MMM d, yyyy")}` : "No plan yet: payroll uses Payroll setup's rates."} />
        {current ? (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 text-sm sm:grid-cols-2">
            {describePlan(current, names).map((l, i) => (
              <div key={i} className="flex justify-between gap-3 border-b border-zinc-50 py-1">
                <dt className="text-zinc-500">{l.label}</dt>
                <dd className="text-right tabular">{l.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="px-4 py-3 text-sm text-zinc-500">
            Payroll setup: ${fb.hourlyRate.toFixed(2)}/h, service {pct(fb.servicePct)}%, product {pct(fb.productPct)}%.
          </p>
        )}
      </Card>
      <Card>
        <CardHeader title="History" subtitle="Newest first. A change saved twice for the same day replaces the earlier one; only changes that haven't started can be withdrawn." />
        {rows.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Starts</Th>
                <Th>Until</Th>
                <Th>Status</Th>
                <Th>Plan</Th>
                <Th>Saved</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const by = r.createdBy;
                return (
                  <tr key={r.id} className="align-top">
                    <Td className="whitespace-nowrap">{formatDate(r.effectiveFrom, "MMM d, yyyy")}</Td>
                    <Td className="whitespace-nowrap">{r.until ? formatDate(r.until, "MMM d, yyyy") : r.status === "replaced" ? "—" : "ongoing"}</Td>
                    <Td>
                      <Badge tone={STATUS_TONE[r.status]}>{VERSION_STATUS_LABEL[r.status]}</Badge>
                    </Td>
                    <Td className="text-xs">
                      {describePlan(r, names)
                        .map((l) => `${l.label}: ${l.value}`)
                        .join(" · ")}
                      {r.note && <p className="mt-1 text-zinc-500">Note: {r.note}</p>}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-zinc-500">
                      {formatDateTime(r.createdAt)}
                      {by && <span className="block">{byName.get(by) ?? "Someone"}</span>}
                    </Td>
                    <Td>{access.edit && r.status === "scheduled" && <DeleteVersion staffId={id} versionId={r.id} />}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <p className="px-4 py-6 text-sm text-zinc-500">No changes yet.</p>
        )}
      </Card>
      {access.edit && (
        <Card>
          <CardHeader
            title="Add a change"
            subtitle="Starts with the latest plan filled in. Saving adds a new version from the date you pick; the ones before it stay as they were. A blank field uses Payroll setup's rate or the shop's setting."
          />
          <VersionEditor
            staffId={id}
            initial={draftOf(rows.find((r) => r.status !== "replaced") ?? null, vc.lockedThrough && vc.today <= vc.lockedThrough ? earliest : vc.today)}
            earliest={earliest}
            shops={shopRows}
            services={serviceRows.filter((s) => s.active)}
            categories={vc.categories.slice().sort()}
            tipMethods={vc.tipMethods.map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
            hints={{
              hourly: `$${fb.hourlyRate.toFixed(2)}/h`,
              servicePct: `${pct(fb.servicePct)}%`,
              productPct: `${pct(fb.productPct)}%`,
              tipMethod: "Wins over their own choice. A shop that pays all tips through payroll still does.",
              cardFee: "Whether Stripe's card fee comes out of their card tips.",
            }}
          />
        </Card>
      )}
      {fields.length > 0 && (
        <Card>
          <CardHeader title="Employee fields" subtitle="The brand's own fields for each employee." />
          {access.edit ? (
            <FieldValues staffId={id} fields={fields.map((f) => ({ id: f.id, label: f.label, kind: f.kind, options: f.options, value: valueOf.get(f.id) ?? "" }))} />
          ) : (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 text-sm sm:grid-cols-2">
              {fields.map((f) => (
                <div key={f.id} className="flex justify-between gap-3 border-b border-zinc-50 py-1">
                  <dt className="text-zinc-500">{f.label}</dt>
                  <dd>{formatFieldValue(f, valueOf.get(f.id) ?? null) || "—"}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      )}
    </div>
  );
}
