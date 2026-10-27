import type { Metadata } from "next";
import { Fragment } from "react";
import { and, eq, isNotNull } from "drizzle-orm";
import { Card, CardHeader, Notice, PageHeader } from "@/components/ui";
import { db } from "@/db";
import { payPeriodDates, payrollProfiles, payrollRates, payrollRuns, staff } from "@/db/schema";
import { periodsAround } from "@/domain/payroll/calendar";
import { todayLocal } from "@/lib/time";
import type { PayrollHoursStyle } from "@/domain/display";
import { can, guardPage } from "@/server/auth/staff";
import { settingAt } from "@/server/brand-sync/settings";
import { TEMPLATE_TABS } from "@/server/payroll/export";
import { ensurePayGroups, loadSettings } from "@/server/payroll/run";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import { payrollEmployerList } from "@/server/payroll/groups";
import { PayrollHoursEditor } from "../../settings/display-editors";
import { EmployerRow, EmployerStatesRow, PayGroupRow, PeriodDatesRow, ProfileRowForm, SettingsForm, type PeriodDatesView } from "./client";

export const metadata: Metadata = { title: "Payroll setup" };

export default async function PayrollSetupPage() {
  const ctx = await guardPage("/admin/payroll/setup");
  const [settings, groups, hoursStyle] = await Promise.all([loadSettings(), ensurePayGroups(), settingAt<PayrollHoursStyle>("display.payroll_hours")]);
  const employers = await payrollEmployerList();
  const people = await db
    .select({ id: staff.id, label: staff.displayLabel, p: payrollProfiles })
    .from(staff)
    .leftJoin(payrollProfiles, eq(payrollProfiles.staffId, staff.id))
    .where(and(eq(staff.kind, "person"), eq(staff.active, true)))
    .orderBy(staff.displayLabel);
  const rates = await db.select().from(payrollRates);
  const [moved, locked] = await Promise.all([
    db.select({ g: payPeriodDates.payGroupId, s: payPeriodDates.periodStart, reason: payPeriodDates.reason }).from(payPeriodDates).where(isNotNull(payPeriodDates.reason)),
    db.select({ g: payrollRuns.payGroupId, s: payrollRuns.periodStart }).from(payrollRuns),
  ]);
  const periodDates = new Map<string, PeriodDatesView>();
  for (const g of groups) {
    for (const p of periodsAround(g.calendar, todayLocal(), 2, 6).reverse()) {
      const k = `${p.start}_${p.end}_${p.checkDate}_${p.submitBy}`;
      const v = periodDates.get(k) ?? { key: k, start: p.start, end: p.end, checkDate: p.checkDate, submitBy: p.submitBy, moved: p.datesMoved, reason: null, locked: false, groups: [] };
      v.groups.push({ label: g.label, code: g.code, number: p.number });
      v.reason ??= moved.find((m) => m.g === g.id && m.s === p.start)?.reason ?? null;
      v.locked ||= locked.some((l) => l.g === g.id && l.s === p.start);
      periodDates.set(k, v);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="Payroll setup" subtitle="Pay groups and their calendars, payroll settings, and each barber's iSolved number and pay rates." />
      <Notice tone="blue">
        Payroll leaves the platform only as the per-shop iSolved files, downloaded once the figures are approved and uploaded by hand (Timecard Import, picking the pay group by its
        code). Nothing here connects to iSolved. Employee numbers are kept in the database only.
      </Notice>
      <Card>
        <CardHeader title="Settings" />
        <div className="px-4 py-3">
          <SettingsForm initial={settings} memoRequired={stripePayoutsOn()} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Payroll hours" subtitle="How hours read on the Payroll Report, timesheets, payroll reports and pay screens. Charles's payroll workbook uses decimal hours. Times of day follow the brand's time format under Brand defaults." />
        <PayrollHoursEditor initial={hoursStyle} canEdit={ctx.brandWide && can(ctx, "payroll.run")} />
      </Card>
      <Card>
        <CardHeader
          title="Pay groups"
          subtitle="Each shop is one iSolved pay group with its own letter code (B is Rock Island, C is Moline) and calendar. Shops with the same legal entity (one FEIN; Ray'z Inc. is the only one) add hours together for overtime, over Sunday-to-Saturday workweeks. The export tab sets the sheet name and formatting; a shop without a tab of its own copies Rock Island's."
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] text-zinc-500">
              <tr>
                <th className="px-2 py-2">Shop</th>
                <th className="px-2 py-2">Pay group label</th>
                <th className="px-2 py-2">iSolved code</th>
                <th className="px-2 py-2">Legal entity (FEIN)</th>
                <th className="px-2 py-2">Export tab</th>
                <th className="px-2 py-2">A period starts</th>
                <th className="px-2 py-2">Its number</th>
                <th className="px-2 py-2">Length</th>
                <th className="px-2 py-2">Due +days</th>
                <th className="px-2 py-2">Check +days</th>
                <th className="px-2 py-2">Yearly numbers</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <PayGroupRow
                  key={g.id}
                  tabs={TEMPLATE_TABS}
                  g={{
                    id: g.id,
                    shop: g.shop,
                    label: g.label,
                    code: g.code ?? "",
                    legalEntity: g.legalEntity,
                    exportTab: g.exportTab,
                    anchorStart: g.calendar.anchorStart,
                    anchorNumber: g.calendar.anchorNumber,
                    periodDays: g.calendar.periodDays,
                    checkOffsetDays: g.calendar.checkOffsetDays,
                    submitOffsetDays: g.calendar.submitOffsetDays,
                    numberResetsYearly: g.calendar.numberResetsYearly,
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Pay period dates"
          subtitle="Each period's iSolved submit-by and check dates, kept from the calendars above. Move one when iSolved's calendar says otherwise (a holiday), with the reason; it applies to every shop with that period. A locked period keeps its dates."
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="pay-period-dates">
            <thead className="bg-zinc-50 text-left text-[11px] text-zinc-500">
              <tr>
                <th className="px-2 py-2">Period</th>
                <th className="px-2 py-2">Dates</th>
                <th className="px-2 py-2">Due in iSolved</th>
                <th className="px-2 py-2">Check date</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {[...periodDates.values()].map((p) => (
                <PeriodDatesRow key={p.key} p={p} />
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
                <th className="px-2 py-2" title="Hours go to iSolved; Hourly Total is $0 on the report">$0 hourly</th>
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
                      zeroHourlyPay: s.p?.zeroHourlyPay ?? false,
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
