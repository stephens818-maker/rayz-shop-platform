import type { Metadata } from "next";
import { Fragment } from "react";
import { and, eq } from "drizzle-orm";
import { Card, CardHeader, Notice, PageHeader } from "@/components/ui";
import { db } from "@/db";
import { payrollProfiles, payrollRates, staff } from "@/db/schema";
import { guardPage } from "@/server/auth/staff";
import { TEMPLATE_TABS } from "@/server/payroll/export";
import { ensurePayGroups, loadSettings } from "@/server/payroll/run";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import { payrollEmployerList } from "@/server/payroll/groups";
import { EmployerRow, EmployerStatesRow, PayGroupRow, ProfileRowForm, SettingsForm } from "./client";

export const metadata: Metadata = { title: "Payroll setup" };

export default async function PayrollSetupPage() {
  await guardPage("/admin/payroll/setup");
  const [settings, groups] = await Promise.all([loadSettings(), ensurePayGroups()]);
  const employers = await payrollEmployerList();
  const people = await db
    .select({ id: staff.id, label: staff.displayLabel, p: payrollProfiles })
    .from(staff)
    .leftJoin(payrollProfiles, eq(payrollProfiles.staffId, staff.id))
    .where(and(eq(staff.kind, "person"), eq(staff.active, true)))
    .orderBy(staff.displayLabel);
  const rates = await db.select().from(payrollRates);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="Payroll setup" subtitle="Pay groups and their calendars, payroll settings, and each barber's iSolved number and pay rates." />
      <Notice tone="blue">
        Payroll leaves the platform only as the per-shop iSolved files, downloaded after approve and lock and uploaded by hand (Timecard Import, picking the pay group). Nothing here connects
        to iSolved. Employee numbers are kept in the database only.
      </Notice>
      <Card>
        <CardHeader title="Settings" />
        <div className="px-4 py-3">
          <SettingsForm initial={settings} memoRequired={stripePayoutsOn()} />
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Pay groups"
          subtitle="Each shop is one iSolved pay group with its own calendar. Shops with the same legal entity (one FEIN) add hours together for overtime. The export tab sets the sheet name and formatting; a shop without a tab of its own copies Rock Island's."
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] text-zinc-500">
              <tr>
                <th className="px-2 py-2">Shop</th>
                <th className="px-2 py-2">Pay group label</th>
                <th className="px-2 py-2">Legal entity (FEIN)</th>
                <th className="px-2 py-2">Export tab</th>
                <th className="px-2 py-2">A period starts</th>
                <th className="px-2 py-2">Its number</th>
                <th className="px-2 py-2">Length</th>
                <th className="px-2 py-2">Check +days</th>
                <th className="px-2 py-2">Yearly numbers</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <PayGroupRow key={g.id} tabs={TEMPLATE_TABS} g={{ id: g.id, shop: g.shop, label: g.label, legalEntity: g.legalEntity, exportTab: g.exportTab, ...g.calendar }} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Employers"
          subtitle="One per legal entity (FEIN) in the pay groups. Every shop, punch, time entry, tip, payout, cash tip declaration and locked pay period is tagged with its shop's employer, and the tips-paid export goes per employer with its iSolved company code. Only the last 4 of the EIN and of each state account number is kept; the full numbers stay in iSolved."
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] text-zinc-500">
              <tr>
                <th className="px-2 py-2">Legal entity</th>
                <th className="px-2 py-2">Shops</th>
                <th className="px-2 py-2">iSolved company code</th>
                <th className="px-2 py-2">EIN last 4</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {employers.map((e) => (
                <Fragment key={e.id}>
                  <EmployerRow e={{ id: e.id, legalName: e.legalName, shops: e.shops, isolvedCompanyCode: e.isolvedCompanyCode ?? "", taxIdLast4: e.taxIdLast4 ?? "" }} />
                  <EmployerStatesRow
                    e={{
                      id: e.id,
                      workStates: e.workStates,
                      unregistered: e.unregistered,
                      states: e.states.map((s) => ({ state: s.state, withholdingIdLast4: s.withholdingIdLast4 ?? "", unemploymentIdLast4: s.unemploymentIdLast4 ?? "", registeredOn: s.registeredOn ?? "" })),
                    }}
                  />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card>
        <CardHeader title="Barbers" subtitle="The Key is the iSolved Employee Number, written as text or a number exactly as set here. Rates apply at every shop unless a shop has its own." />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] text-zinc-500">
              <tr>
                <th className="px-2 py-2">Barber</th>
                <th className="px-2 py-2">Employee Number</th>
                <th className="px-2 py-2">Key is text</th>
                <th className="px-2 py-2">iSolved name</th>
                <th className="px-2 py-2">Row order</th>
                <th className="px-2 py-2">Occupation code</th>
                <th className="px-2 py-2">Hourly</th>
                <th className="px-2 py-2">Service %</th>
                <th className="px-2 py-2">Product %</th>
                <th className="px-2 py-2">Training rate</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {people.map((s) => {
                const r = rates.find((x) => x.staffId === s.id && x.shopId === null);
                return (
                  <ProfileRowForm
                    key={s.id}
                    p={{
                      staffId: s.id,
                      label: s.label,
                      employeeNumber: s.p?.employeeNumber ?? "",
                      keyIsText: s.p?.keyIsText ?? false,
                      isolvedName: s.p?.isolvedName ?? "",
                      exportPosition: s.p?.exportPosition ?? null,
                      tippedOccupationCode: s.p?.tippedOccupationCode ?? "",
                      hourlyRate: r?.hourlyRate ?? 0,
                      servicePct: r?.servicePct ?? 0,
                      productPct: r?.productPct ?? 0.15,
                      trainingRate: r?.trainingRate ?? null,
                      shopRates: rates.filter((x) => x.staffId === s.id && x.shopId !== null).length,
                    }}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
