import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { Card, CardHeader, Empty, PageHeader, Table, Td, Th } from "@/components/ui";
import { EXPORT_FIELDS, mappingText } from "@/domain/time-clock";
import { formatDateTime } from "@/lib/time";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { loadSettings } from "@/server/payroll/run";
import { listDevices, loadClockRules, shopClocks } from "@/server/time-clock";
import { RevokeDevice, RulesForm, ShopClockForm } from "./client";

export const metadata: Metadata = { title: "Time clock setup" };

export default async function TimeClockSetupPage() {
  const ctx = await guardPage("/admin/time-clock");
  const brand = can(ctx, "payroll.run");
  const shopLevel = can(ctx, "settings.shop");
  const mine = openShops(ctx).map((s) => s.id);
  const h = await headers();
  const myIp = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || null;
  const [rules, pay, clocks, devices] = await Promise.all([loadClockRules(), brand ? loadSettings() : null, shopLevel ? shopClocks(mine) : [], shopLevel ? listDevices(mine) : []]);
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Time clock setup" subtitle="Break and alert rules, how each shop checks a punch is really there, front-desk devices, and the iSolved export layout." />
      {brand && pay && (
        <Card>
          <CardHeader
            title="Rules for every shop"
            subtitle={
              <>
                Overtime is set in <Link href="/admin/payroll/setup" className="underline">payroll setup</Link>: over {pay.otThresholdHours} h a week (federal FLSA)
                {pay.dailyOtHours ? ` and over ${pay.dailyOtHours} h a day` : ", no daily overtime"}. Iowa and Illinois rules are still to be confirmed with the accountant. Full time is over {pay.ftHoursPerWeek} h a week on average.
              </>
            }
          />
          <RulesForm
            initial={{
              unpaidBreakFromMinutes: rules.unpaidBreakFromMinutes,
              autoMealMinutes: rules.autoMealMinutes,
              autoMealAfterHours: rules.autoMealAfterHours,
              forgotOutAfterMinutes: rules.forgotOutAfterMinutes,
              maxShiftHours: rules.maxShiftHours,
              graceMinutes: rules.graceMinutes,
              mapping: mappingText(rules.isolvedColumns),
            }}
            fields={Object.entries(EXPORT_FIELDS).map(([key, f]) => ({ key, label: f.label }))}
          />
        </Card>
      )}
      {shopLevel &&
        clocks.map((c) => (
          <Card key={c.id}>
            <CardHeader title={`${c.name}: checking punches and the calendar`} />
            <ShopClockForm shopId={c.id} initial={c.settings} latitude={c.latitude} longitude={c.longitude} myIp={myIp} />
          </Card>
        ))}
      {shopLevel && (
        <Card>
          <CardHeader
            title="Front-desk clock devices"
            subtitle="A registered device can run the front-desk clock and counts as the shop's device for phone punches."
            action={
              <Link href="/admin/clock/kiosk" className="text-sm underline">
                Register this device
              </Link>
            }
          />
          {devices.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Device</Th>
                  <Th>Shop</Th>
                  <Th>Registered</Th>
                  <Th>Last used</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id}>
                    <Td>{d.label}</Td>
                    <Td>{d.shop}</Td>
                    <Td>{formatDateTime(d.createdAt)}</Td>
                    <Td>{d.lastSeenAt ? formatDateTime(d.lastSeenAt) : "Never"}</Td>
                    <Td>
                      <RevokeDevice id={d.id} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <div className="p-4">
              <Empty title="No devices registered yet">Open the front-desk clock on the shop&apos;s tablet or computer and register it there.</Empty>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
