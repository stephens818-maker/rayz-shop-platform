import type { Metadata } from "next";
import Link from "next/link";
import { inArray } from "drizzle-orm";
import { Badge, Card, CardHeader, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { formatDate, formatDateTime } from "@/lib/time";
import { can, guardPage } from "@/server/auth/staff";
import { cleanCandidates, cleanPeriodCheck, rolloutView } from "@/server/rollout";
import { STAGE } from "../cutover/stages";
import { CleanSignOff, PlanForm, SquireImport } from "./client";

export const metadata: Metadata = { title: "Rollout" };

const range = (start: string, end: string) => `${formatDate(start, "MMM d")} – ${formatDate(end, "MMM d")}`;

export default async function RolloutPage() {
  const ctx = await guardPage("/admin/rollout");
  const owner = can(ctx, "settings.brand");
  const view = await rolloutView();
  const pilotRow = view.shops.find((s) => s.wave === 1 && s.plan);
  const candidates = pilotRow && !pilotRow.plan?.cleanSignedAt ? await cleanCandidates() : null;
  const checks = candidates ? await Promise.all(candidates.periods.map((p) => cleanPeriodCheck(candidates.shopId, p.start))) : [];
  const signer = pilotRow?.plan?.cleanSignedBy ? (await db.select({ label: staff.displayLabel }).from(staff).where(inArray(staff.id, [pilotRow.plan.cleanSignedBy])))[0]?.label : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="Rollout"
        subtitle="One pilot shop goes live first while Squire stays as its backup; the rest switch after the pilot's first clean pay period. Per shop: its wave, when it goes live, the first pay period whose payroll comes from here (before that, from the Squire Commissions report imported for the period), and how long Squire is kept as the backup. Online booking moves on Squire cutover."
      />
      {!view.active && (
        <Notice tone="blue">
          No rollout is planned yet, so every shop&apos;s payroll comes from this platform. Saving the first shop&apos;s plan starts it: from then on, each shop&apos;s payroll comes from Squire data until the pay
          period set for it.
        </Notice>
      )}
      <Card>
        <CardHeader title="Go-live flags" subtitle="Where each shop books and where each pay period's payroll comes from." />
        <Table>
          <thead>
            <tr>
              <Th>Shop</Th>
              <Th>Wave</Th>
              <Th>Planned go-live</Th>
              <Th>Online booking</Th>
              <Th>Payroll by pay period</Th>
              <Th>Squire backup</Th>
            </tr>
          </thead>
          <tbody>
            {view.shops.map((s) => {
              const toImport = s.periods.filter((p) => p.source === "squire" && !p.locked);
              return [
                <tr key={s.shop.id}>
                  <Td>
                    <div className="font-medium">{s.shop.name}</div>
                    {s.plan?.note && <div className="text-xs text-zinc-500">{s.plan.note}</div>}
                  </Td>
                  <Td>{view.active ? <Badge tone={s.wave === 1 ? "violet" : "gray"}>{s.wave === 1 ? "Pilot" : "Second wave"}</Badge> : "—"}</Td>
                  <Td>{s.plan?.plannedOn ? formatDate(s.plan.plannedOn, "EEE, MMM d") : "—"}</Td>
                  <Td>
                    <Link href={`/admin/cutover/${s.shop.id}`}>
                      <Badge tone={STAGE[s.stage].tone}>{STAGE[s.stage].label}</Badge>
                    </Link>
                    {s.switchedAt && s.stage === "live" && <div className="mt-1 text-xs text-zinc-500">Since {formatDateTime(s.switchedAt)}</div>}
                    {s.switchBlocked && <div className="mt-1 max-w-xs text-xs text-amber-700">{s.switchBlocked}</div>}
                  </Td>
                  <Td>
                    <ul className="space-y-0.5 text-xs">
                      {s.periods.map((p) => (
                        <li key={p.start}>
                          <span className="text-zinc-500">{range(p.start, p.end)}:</span>{" "}
                          {p.source === "platform" ? (
                            <Badge tone="green">From here</Badge>
                          ) : p.squireImport ? (
                            <Badge tone="blue">{`Squire data, ${p.squireImport.rows} ${p.squireImport.rows === 1 ? "person" : "people"}`}</Badge>
                          ) : (
                            <Badge tone={p.locked ? "gray" : "amber"}>{p.locked ? "Squire data, none imported" : "Squire data, not imported"}</Badge>
                          )}
                          {p.locked && <span className="ml-1 text-zinc-500">locked</span>}
                        </li>
                      ))}
                    </ul>
                  </Td>
                  <Td>{s.plan?.squireBackupUntil ? `${s.squireBackup ? "Until" : "Ended"} ${formatDate(s.plan.squireBackupUntil, "MMM d")}` : "—"}</Td>
                </tr>,
                <tr key={`${s.shop.id}-edit`} className="bg-zinc-50/60">
                  <Td className="pt-0" />
                  <td colSpan={5} className="space-y-3 px-3 pb-3">
                    {owner && (
                      <PlanForm
                        shopId={s.shop.id}
                        periodStarts={s.periodStarts}
                        initial={{
                          wave: s.wave,
                          plannedOn: s.plan?.plannedOn ?? "",
                          payrollFrom: s.plan?.payrollFrom ?? "",
                          squireBackupUntil: s.plan?.squireBackupUntil ?? "",
                          note: s.plan?.note ?? "",
                        }}
                      />
                    )}
                    {view.active && toImport.length > 0 && (
                      <div>
                        <div className="mb-1 text-xs font-medium text-zinc-600">Squire Commissions report for {s.shop.name}</div>
                        <SquireImport shopId={s.shop.id} periods={toImport.map((p) => ({ start: p.start, end: p.end, imported: !!p.squireImport }))} />
                      </div>
                    )}
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Pilot's clean pay period" subtitle="The second wave switches once an owner signs off one clean pay period at the pilot on this platform." />
        <div className="space-y-3 px-4 py-3 text-sm">
          {!pilotRow && <p className="text-zinc-600">No pilot shop yet. Set one shop&apos;s wave to Pilot above.</p>}
          {pilotRow?.plan?.cleanSignedAt && (
            <Notice tone="green">
              {pilotRow.shop.name}&apos;s pay period {range(pilotRow.plan.cleanPeriodStart!, pilotRow.plan.cleanPeriodEnd!)} was signed off clean by {signer ?? "an owner"} on {formatDateTime(pilotRow.plan.cleanSignedAt)}: &ldquo;
              {pilotRow.plan.cleanNote}&rdquo;. The second wave can switch on Squire cutover.
            </Notice>
          )}
          {pilotRow && !pilotRow.plan?.cleanSignedAt && !pilotRow.plan?.payrollFrom && <p className="text-zinc-600">Set the pay period {pilotRow.shop.name}&apos;s payroll comes from here, starting the day it goes live.</p>}
          {candidates && !checks.length && <p className="text-zinc-600">{pilotRow?.shop.name}&apos;s first pay period on this platform hasn&apos;t ended yet.</p>}
          {checks.map((r) => (
            <div key={r.period.start} className="rounded-md ring-1 ring-zinc-200">
              <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
                <span className="font-medium">{range(r.period.start, r.period.end)}</span>
                <Badge tone={r.ok ? "green" : "amber"}>{r.ok ? "Clean" : "Not clean yet"}</Badge>
              </div>
              <ul className="space-y-1 px-3 py-2 text-xs">
                {r.checks.map((c) => (
                  <li key={c.label}>
                    <span className={c.ok ? "text-emerald-700" : "text-amber-700"}>{c.ok ? "✓" : "✗"}</span> <span className="font-medium">{c.label}.</span> <span className="text-zinc-600">{c.detail}</span>
                  </li>
                ))}
              </ul>
              {r.ok && owner && pilotRow && (
                <div className="border-t border-zinc-100 px-3 py-2">
                  <CleanSignOff shopId={pilotRow.shop.id} periodStart={r.period.start} />
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
