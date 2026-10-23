import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { shops, staff, timePunches } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { FLAG_LABEL, METHOD_LABEL, PUNCH_LABEL, clockRuleText, type PunchFlag } from "@/domain/time-clock";
import { formatDate, formatTime, startOfLocalDay, todayLocal } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { clockState, shopClocks } from "@/server/time-clock";
import { ClockPanel, OpensEarlyForm, PinForm, type ClockShop } from "./clock";

export const metadata: Metadata = { title: "Time clock" };

export default async function ClockPage() {
  const ctx = await guardPage("/admin/clock");
  const me = ctx.staff.id;
  if (ctx.staff.kind !== "person") return <Empty title="Shop logins don't punch">Use the front-desk clock, where each person punches with their own PIN.</Empty>;
  const now = new Date();
  const team = await workShopIds(me);
  const ids = [...new Set([...team, ...openShops(ctx).map((s) => s.id)])];
  const open = ids.length ? (await db.select({ id: shops.id }).from(shops).where(and(inArray(shops.id, ids), ne(shops.status, "archived")))).map((s) => s.id) : [];
  if (!open.length) return <Empty title="You aren't on a shop's team yet">Ask a manager to add you to a shop.</Empty>;
  const [state, clocks, today, [mine]] = await Promise.all([
    clockState(me, now),
    shopClocks(open),
    db
      .select({ id: timePunches.id, type: timePunches.type, at: timePunches.at, shop: shops.name, method: timePunches.method, flags: timePunches.flags })
      .from(timePunches)
      .innerJoin(shops, eq(shops.id, timePunches.shopId))
      .where(and(eq(timePunches.staffId, me), gte(timePunches.at, startOfLocalDay(todayLocal(now))), isNull(timePunches.voidedAt)))
      .orderBy(asc(timePunches.at)),
    db.select({ pin: staff.clockPinHash, opensEarly: staff.clockOpensEarly }).from(staff).where(eq(staff.id, me)),
  ]);
  const earlyShops = clocks.filter((c) => c.settings.openEarly && team.includes(c.id)).map((c) => c.name);
  const primary = team.find((s) => open.includes(s)) ?? null;
  const list: ClockShop[] = clocks.map((c) => ({ id: c.id, name: c.name, gps: c.settings.methods.includes("gps"), photo: c.settings.photo, rule: clockRuleText(c.settings) }));
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader
        title="Time clock"
        subtitle="Clock in when you start, take your breaks, clock out when you leave. Punch at the shop you're working at today."
        actions={
          can(ctx, "timesheet.own") ? (
            <Link href={`/admin/timesheets/${me}`} className="text-sm underline">
              My timesheet
            </Link>
          ) : undefined
        }
      />
      {state.stale && (
        <Notice>
          Your clock-in at {state.stale.shop} on {formatDate(state.stale.start)} at {formatTime(state.stale.start)} was never clocked out. A manager will fix it; you can clock in again now.
        </Notice>
      )}
      <ClockPanel
        shops={list}
        state={state.state}
        shiftShopId={state.shift?.shopId ?? null}
        since={state.shift?.start.toISOString() ?? null}
        breakSince={state.shift?.breakStart?.toISOString() ?? null}
        next={state.next}
        defaultShopId={primary}
      />
      <Card>
        <CardHeader title="Today" subtitle={today.length ? undefined : "No punches yet today."} />
        {today.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Punch</Th>
                <Th>Shop</Th>
                <Th>How</Th>
              </tr>
            </thead>
            <tbody>
              {today.map((p) => (
                <tr key={p.id}>
                  <Td>{formatTime(p.at)}</Td>
                  <Td>
                    {PUNCH_LABEL[p.type]}
                    {(p.flags as PunchFlag[])
                      .filter((f) => f in FLAG_LABEL)
                      .map((f) => (
                        <Badge key={f} tone="amber" className="ml-1">
                          {FLAG_LABEL[f]}
                        </Badge>
                      ))}
                  </Td>
                  <Td>{p.shop}</Td>
                  <Td>{METHOD_LABEL[p.method]}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {can(ctx, "timeclock.punch") && <PinForm hasPin={!!mine?.pin} />}
      {can(ctx, "timeclock.punch") && <OpensEarlyForm on={!!mine?.opensEarly} shops={earlyShops} />}
    </div>
  );
}
