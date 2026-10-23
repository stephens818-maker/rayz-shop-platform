import type { Metadata } from "next";
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { shops, timeBlocks } from "@/db/schema";
import { Empty, PageHeader } from "@/components/ui";
import { CATEGORY_LABEL } from "@/domain/staff-time";
import { localMinutesOf, todayLocal } from "@/lib/time";
import { workShopIds } from "@/server/auth/access";
import { can, guardPage } from "@/server/auth/staff";
import { listRequests, myBlocks, rulesFor } from "@/server/staff-time";
import { LunchNow, MyRequests, QuickBlock, Recurring, TimeOffForm, Upcoming } from "./my-time";

export const metadata: Metadata = { title: "My time" };

export default async function MyTimePage() {
  const ctx = await guardPage("/admin/my-time");
  const me = ctx.staff.id;
  const canBlock = can(ctx, "blocks.own") || can(ctx, "blocks.others");
  const canRequest = can(ctx, "timeoff.request");
  const now = new Date();
  const today = todayLocal(now);
  const mine = await workShopIds(me);
  if (!mine.length) return <Empty title="You aren't on a shop's team yet">Ask a manager to add you to a shop.</Empty>;
  const [blocks, requests, rules, shopRows, current] = await Promise.all([
    myBlocks(me, now),
    canRequest ? listRequests({ staffId: me }, { since: new Date(now.getTime() - 30 * 86_400_000), limit: 50 }) : Promise.resolve([]),
    rulesFor(me, null),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, mine)),
    db.query.timeBlocks.findFirst({ where: and(eq(timeBlocks.staffId, me), lte(timeBlocks.startsAt, now), gt(timeBlocks.endsAt, now)) }),
  ]);
  const nowMin = localMinutesOf(now);
  const nextQuarter = Math.min(Math.ceil((nowMin + 1) / 15) * 15, 23 * 60 + 45);
  const limits = can(ctx, "blocks.others") ? null : { maxLunchMin: rules.maxLunchMin, maxBlockMin: rules.maxBlockMin };
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader
        title="My time"
        subtitle={
          <>
            Lunch, breaks and time off. Blocks come off online booking at once and show shaded on the calendar
            {shopRows.length > 1 ? ` at all ${shopRows.length} of your shops` : ""}.
          </>
        }
      />
      {canBlock && (
        <>
          <LunchNow current={current ? { label: current.category === "time_off" ? "Time off" : (CATEGORY_LABEL[current.category] ?? current.reason), untilMin: localMinutesOf(current.endsAt) } : null} />
          <QuickBlock today={today} defaultStartMin={nextQuarter} limits={limits} />
          <Recurring series={blocks.series} today={today} limits={limits} />
          <Upcoming blocks={blocks.blocks} />
        </>
      )}
      {canRequest && (
        <>
          <TimeOffForm today={today} shops={shopRows} rules={{ minNoticeDays: rules.minNoticeDays, approval: rules.timeOffApproval }} />
          <MyRequests requests={requests} />
        </>
      )}
    </div>
  );
}
