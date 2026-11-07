import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { services, shops, staff, staffMilestoneBaselines } from "@/db/schema";
import { Card, CardHeader, PageHeader, Table, Td, Th } from "@/components/ui";
import { KIND_LABEL, METRICS, MILESTONE_KINDS, type MilestoneMetric, type RuleLike, ruleUnit } from "@/domain/milestones";
import { formatDate, todayLocal } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { loadMilestoneSettings, loadRules, people } from "@/server/milestones/engine";
import { BaselineForm, CheckNow, MilestoneSettingsForm, NewRule, RemoveBaseline, RuleRowView } from "./client";

export const metadata: Metadata = { title: "Staff milestones" };
export const dynamic = "force-dynamic";

function summary(r: RuleLike, serviceNames: Map<string, string>): string {
  const info = METRICS[r.metric as MilestoneMetric];
  const numbers = r.thresholds.map((t) => t.toLocaleString("en-US")).join(", ");
  const only = r.serviceIds.length ? ` · only ${r.serviceIds.map((id) => serviceNames.get(id) ?? "a removed service").join(", ")}` : "";
  if (r.kind === "count" || r.kind === "streak") return `${numbers} ${ruleUnit(r)}${only}`;
  if (r.kind === "anniversary") return `${numbers} years from the hire date`;
  return info?.hint ?? "";
}

export default async function MilestoneSettingsPage() {
  const ctx = await guardPage("/admin/milestones/settings");
  const [s, rules, serviceRows, team, baselineRows, shopRows] = await Promise.all([
    loadMilestoneSettings(),
    loadRules(),
    db.select({ id: services.id, name: services.name }).from(services).where(and(eq(services.active, true), eq(services.kind, "service"))).orderBy(asc(services.name)),
    people(),
    db.select({ b: staffMilestoneBaselines, label: staff.displayLabel }).from(staffMilestoneBaselines).innerJoin(staff, eq(staff.id, staffMilestoneBaselines.staffId)).orderBy(asc(staff.displayLabel), asc(staffMilestoneBaselines.metric)),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(and(eq(shops.isDemo, false), ne(shops.status, "archived"))).orderBy(asc(shops.name)),
  ]);
  const serviceNames = new Map(serviceRows.map((x) => [x.id, x.name]));
  const noHire = team.filter((p) => !p.hireDate);
  const today = todayLocal();
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Staff milestones"
        subtitle={
          <>
            What&rsquo;s celebrated and who hears about it. People see theirs on{" "}
            <Link href="/admin/milestones" className="underline">
              Milestones
            </Link>
            .
          </>
        }
        actions={<CheckNow />}
      />
      <Card>
        <CardHeader title="Settings" />
        <MilestoneSettingsForm initial={s} shops={shopRows} />
      </Card>
      <Card>
        <CardHeader
          title="Milestones"
          subtitle="Change the numbers, turn any off, or add your own. Each is reached once per person; changing a number later doesn't take back one already reached."
          action={<NewRule services={serviceRows} brand={ctx.brandWide} />}
        />
        <div className="divide-y divide-zinc-100">
          {MILESTONE_KINDS.map((k) => {
            const list = rules.filter((r) => r.kind === k);
            if (!list.length) return null;
            return (
              <section key={k} className="space-y-3 px-4 py-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{KIND_LABEL[k]}</h3>
                {list.map((r) => (
                  <RuleRowView
                    key={r.id}
                    rule={r}
                    services={serviceRows}
                    summary={summary(r, serviceNames)}
                    brand={ctx.brandWide}
                  />
                ))}
              </section>
            );
          })}
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Squire totals"
          subtitle="For history from before what was imported: a person's total as of a date. Visits on or after that date count on top. Milestones a total already covers are kept quietly, with no alert."
        />
        <div className="space-y-3 p-4">
          {baselineRows.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Person</Th>
                  <Th>Total of</Th>
                  <Th right>Total</Th>
                  <Th>Before</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {baselineRows.map(({ b, label }) => (
                  <tr key={`${b.staffId}:${b.metric}`}>
                    <Td>{label}</Td>
                    <Td>{METRICS[b.metric as MilestoneMetric]?.label ?? b.metric}</Td>
                    <Td right className="tabular-nums">
                      {b.count.toLocaleString("en-US")}
                    </Td>
                    <Td>{formatDate(b.asOf, "MMM d, yyyy")}</Td>
                    <Td right>
                      <RemoveBaseline staffId={b.staffId} metric={b.metric} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <BaselineForm people={team.map((p) => ({ id: p.id, name: p.label }))} today={today} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Hire dates" subtitle="Work anniversaries come from the hire date on each staff profile." />
        {noHire.length ? (
          <div className="p-4 text-sm">
            <p className="mb-2 text-zinc-600">
              {noHire.length}{" "}
              {noHire.length === 1 ? "person has" : "people have"} no hire date
              yet:
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {noHire.map((p) => (
                <li key={p.id}>
                  <Link href={`/admin/staff/${p.id}`} className="text-brand-700 hover:underline">
                    {p.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="px-4 py-4 text-sm text-zinc-500">Everyone has a hire date.</p>
        )}
      </Card>
    </div>
  );
}
