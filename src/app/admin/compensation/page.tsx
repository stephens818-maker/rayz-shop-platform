import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffCustomValues } from "@/db/schema";
import { Card, CardHeader, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { versionOn } from "@/domain/compensation";
import { formatDate, todayLocal } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { customFields, loadCompensationSettings, versionsFor } from "@/server/compensation";
import { FieldDefForm, SettingsForm } from "./client";

export const metadata: Metadata = { title: "Compensation" };

export default async function CompensationSettingsPage() {
  const ctx = await guardPage("/admin/compensation");
  const [settings, fields, used] = await Promise.all([
    loadCompensationSettings(),
    customFields(),
    db.select({ fieldId: staffCustomValues.fieldId, n: sql<number>`count(*)::int` }).from(staffCustomValues).groupBy(staffCustomValues.fieldId),
  ]);
  const people = settings.enabled
    ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(and(eq(staff.kind, "person"), eq(staff.active, true))).orderBy(asc(staff.displayLabel))
    : [];
  const versions = await versionsFor(people.map((p) => p.id));
  const today = todayLocal();
  const usedOf = new Map(used.map((u) => [u.fieldId, u.n]));

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="Compensation" subtitle="Optional pay plan fields for each employee, the brand's own employee fields, and how payroll and the iSolved files use them." />
      <Notice tone="blue">
        Pay terms only. Bank accounts, cards, SSNs and tax IDs stay with Stripe and iSolved; employee fields can&apos;t be made for them. Who sees and edits compensation is set in Permissions (“See
        compensation”, “Edit compensation”, “See their own pay”); by default only the Brand Owner and Brand Admins have it.
      </Notice>
      <Card>
        <CardHeader title="Settings" subtitle="Everything is off until you turn it on." />
        <SettingsForm initial={settings} />
      </Card>
      <Card>
        <CardHeader title="Employee fields" subtitle="Text, number, percent, date or dropdown fields on each employee's Compensation tab. Retiring a field hides it and keeps what was entered." />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] text-zinc-500">
              <tr>
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Choices</th>
                <th className="px-2 py-2">Order</th>
                <th className="px-2 py-2">Filled in for</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <FieldDefForm
                  key={`${f.id}:${f.updatedAt.toISOString()}`}
                  f={{
                    id: f.id,
                    label: f.label,
                    kind: f.kind,
                    options: f.options,
                    position: f.position,
                    active: f.active,
                    used: usedOf.get(f.id) ?? 0,
                  }}
                  brand={ctx.brandWide}
                />
              ))}
              <FieldDefForm f={null} brand={ctx.brandWide} />
            </tbody>
          </table>
        </div>
      </Card>
      {settings.enabled && (
        <Card>
          <CardHeader title="Employees" subtitle="Each person's plan is on their Compensation tab." />
          <Table>
            <thead>
              <tr>
                <Th>Employee</Th>
                <Th>Plan in effect since</Th>
                <Th>Next change</Th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => {
                const vs = versions.get(p.id) ?? [];
                const now = versionOn(vs, today);
                const next = vs.filter((v) => v.effectiveFrom > today).at(-1);
                return (
                  <tr key={p.id}>
                    <Td>
                      <Link className="font-medium hover:underline" href={`/admin/staff/${p.id}/compensation`}>
                        {p.label}
                      </Link>
                    </Td>
                    <Td>{now ? formatDate(now.effectiveFrom, "MMM d, yyyy") : <span className="text-zinc-500">No plan (Payroll setup&apos;s rates)</span>}</Td>
                    <Td>{next ? formatDate(next.effectiveFrom, "MMM d, yyyy") : "—"}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
