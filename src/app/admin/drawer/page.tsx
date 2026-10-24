import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { cashDrawers, staff, tipPayouts } from "@/db/schema";
import { Card, CardHeader, Empty, LinkButton, Notice, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { addDays, formatDate, formatDateTime, formatTime, isValidLocalDate, todayLocal } from "@/lib/time";
import { can, guardPage, workingShopId } from "@/server/auth/staff";
import { drawerSummary } from "@/server/checkout";
import { drawerBalanceHistory } from "@/server/drawer";
import { DRAWER_EVENT_LABEL } from "@/domain/drawer";
import { shopTipConfig } from "@/server/tips/ledger";
import { cashAwaiting } from "@/server/tips/payouts";
import { BuildBatch, CashAck } from "../tips/client";
import { CloseDrawerForm } from "./close-form";
import { DrawerMoveForm, OpenDrawerForm } from "./open-form";

export const metadata: Metadata = { title: "Cash drawer" };

export default async function DrawerPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const sp = await searchParams;
  const ctx = await guardPage("/admin/drawer");
  const shopId = workingShopId(ctx);
  if (!shopId) return <Empty title="No shop selected" />;
  const shop = ctx.shops.find((s) => s.id === shopId)!;
  const date = sp.date && isValidLocalDate(sp.date) ? sp.date : todayLocal();
  const today = todayLocal();
  const [s, history, tipSettings, awaiting, draft, paidTips, timeline] = await Promise.all([
    drawerSummary(shopId, date),
    db
      .select({ d: cashDrawers, by: staff.displayLabel })
      .from(cashDrawers)
      .leftJoin(staff, eq(staff.id, cashDrawers.closedBy))
      .where(and(eq(cashDrawers.shopId, shopId), isNotNull(cashDrawers.closedAt)))
      .orderBy(desc(cashDrawers.businessDate))
      .limit(14),
    shopTipConfig(shopId),
    cashAwaiting(shopId),
    db.query.tipPayoutBatches.findFirst({ where: (b, { and, eq }) => and(eq(b.shopId, shopId), eq(b.status, "draft")) }),
    db
      .select({ p: tipPayouts, name: staff.displayLabel })
      .from(tipPayouts)
      .innerJoin(staff, eq(staff.id, tipPayouts.staffId))
      .where(and(eq(tipPayouts.shopId, shopId), eq(tipPayouts.method, "cash"), eq(tipPayouts.status, "paid"), eq(tipPayouts.drawerDate, date))),
    drawerBalanceHistory(shopId, date),
  ]);
  const closed = s.drawer?.closedAt;
  const canTips = can(ctx, "tips.approve");
  const showTips = canTips || awaiting.length > 0 || paidTips.length > 0;
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="End-of-day cash drawer"
        subtitle={`${shop.name} · ${formatDate(date, "EEEE, MMM d")}`}
        actions={
          <>
            <Link className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={`/admin/drawer?date=${addDays(date, -1)}`}>
              ‹ Prev
            </Link>
            <Link className="rounded-lg px-3 py-2 text-sm ring-1 ring-zinc-300 hover:bg-white" href={`/admin/drawer?date=${addDays(date, 1)}`}>
              Next ›
            </Link>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Cash sales" value={formatCents(s.cashSalesCents)} hint={`${s.cashTickets} tickets · tips ${formatCents(s.cashTipsCents)}`} />
        <Stat label="Cash refunds" value={formatCents(s.cashRefundsCents)} />
        <Stat
          label="Expected in drawer"
          value={formatCents(s.expectedCents)}
          hint={`opening ${formatCents(s.openingFloatCents)} − payouts ${formatCents(s.payoutsCents)}${s.tipPayoutsCents ? ` − tip payouts ${formatCents(s.tipPayoutsCents)}` : ""}`}
        />
        <Stat label="Card (for reference)" value={formatCents(s.cardCents)} hint={`${s.cardTickets} card payments`} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1fr]">
        {!closed && (
          <Card>
            {s.opened ? (
              <>
                <CardHeader
                  title="Drawer open"
                  subtitle={`Opened ${formatDateTime(s.drawer!.openedAt!)} with ${formatCents(s.drawer!.openingFloatCents)}. Record cash put in or taken out so the close balances.`}
                />
                <DrawerMoveForm shopId={shopId} date={date} />
              </>
            ) : (
              <>
                <CardHeader title="Open the drawer" subtitle="Count what's in the drawer before the first sale. Cash paid in or out can be recorded once it's open." />
                <OpenDrawerForm shopId={shopId} date={date} defaultCents={s.openingFloatCents} />
              </>
            )}
          </Card>
        )}
        <Card>
          <CardHeader title={closed ? "Drawer closed" : "Count and close"} subtitle={closed ? `Closed ${formatDateTime(closed)}` : "Count the drawer, then close. Voids are locked once the drawer is closed."} />
          {closed ? (
            <dl className="space-y-1 p-4 text-sm tabular">
              <Row k="Opening balance" v={formatCents(s.drawer!.openingFloatCents)} />
              <Row k="Payouts" v={formatCents(s.drawer!.payoutsCents)} />
              {s.drawer!.tipPayoutsCents > 0 && <Row k="Cash tip payouts" v={formatCents(s.drawer!.tipPayoutsCents)} />}
              <Row k="Expected" v={formatCents(s.drawer!.expectedCents)} />
              <Row k="Counted" v={formatCents(s.drawer!.countedCents ?? 0)} />
              <Row k="Over / short" v={formatCents(s.drawer!.varianceCents ?? 0, { sign: true })} strong />
              {s.drawer!.notes && <p className="pt-2 text-zinc-600">{s.drawer!.notes}</p>}
            </dl>
          ) : (
            <>
              {awaiting.length > 0 && (
                <div className="px-4 pt-4">
                  <Notice>Pay out or hold the cash tips below before closing.</Notice>
                </div>
              )}
              <CloseDrawerForm shopId={shopId} date={date} cashSalesCents={s.cashSalesCents} cashRefundsCents={s.cashRefundsCents} tipPayoutsCents={s.tipPayoutsCents} defaultFloatCents={s.openingFloatCents} opened={s.opened} movesOutCents={s.movesOutCents} />
            </>
          )}
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Balance history" subtitle="Every cash movement today and what should be in the drawer after it." />
          {timeline.length ? (
            <div data-testid="balance-history">
              <Table>
                <thead>
                  <tr>
                    <Th>Time</Th>
                    <Th>What</Th>
                    <Th>By</Th>
                    <Th right>Amount</Th>
                    <Th right>Balance</Th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.map((l, i) => (
                    <tr key={i}>
                      <Td className="whitespace-nowrap">{formatTime(l.at)}</Td>
                      <Td>
                        {DRAWER_EVENT_LABEL[l.kind]}
                        {l.label ? <span className="text-zinc-500"> · {l.label}</span> : null}
                      </Td>
                      <Td>{l.by ?? "—"}</Td>
                      <Td right>{l.kind === "open" || l.kind === "close" ? formatCents(l.cents) : formatCents(l.kind === "sale" || l.kind === "paid_in" ? l.cents : -l.cents, { sign: true })}</Td>
                      <Td right className={l.varianceCents ? (l.varianceCents < 0 ? "text-red-600" : "text-amber-700") : ""}>
                        {l.kind === "close" ? `${formatCents(l.varianceCents ?? 0, { sign: true })} vs ${formatCents(l.balanceCents)}` : formatCents(l.balanceCents)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : (
            <p className="px-4 py-4 text-sm text-zinc-500">No cash in or out yet.</p>
          )}
        </Card>
        {showTips && date === today && !closed && (
          <Card className="lg:col-span-2 lg:order-first">
            <CardHeader
              title="Tip payouts from the drawer"
              subtitle="Each employee takes their cash tips and confirms with their clock PIN or by typing their name. It comes out of the expected count."
              action={
                canTips && tipSettings.schedule !== "payroll" ? (
                  draft ? (
                    <LinkButton size="sm" href={`/admin/tips/${draft.id}`}>
                      Review and approve tonight&rsquo;s tips
                    </LinkButton>
                  ) : (
                    <BuildBatch shopId={shopId} defaultCutoff={today} today={today} hasDraft={false} label={awaiting.length || paidTips.length ? "Build a batch for later tips" : tipSettings.schedule === "end_of_night" ? "Build tonight's tip payouts" : "Build a tip batch"} />
                  )
                ) : undefined
              }
            />
            <div className="divide-y divide-zinc-100">
              {awaiting.map(({ p, name }) => (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <div className="font-medium">{name}</div>
                    <div className="text-sm tabular text-zinc-600">{formatCents(p.netCents)} cash</div>
                  </div>
                  <CashAck payoutId={p.id} name={name} amount={formatCents(p.netCents)} />
                </div>
              ))}
              {paidTips.map(({ p, name }) => (
                <div key={p.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span>
                    {name} <span className="text-zinc-500">· {p.ackMethod === "pin" ? "PIN" : `signed "${p.ackName}"`} · {formatDateTime(p.acknowledgedAt!)}</span>
                  </span>
                  <span className="tabular">{formatCents(p.netCents)}</span>
                </div>
              ))}
              {!awaiting.length && !paidTips.length && <p className="px-4 py-4 text-sm text-zinc-500">No cash tip payouts waiting.</p>}
            </div>
          </Card>
        )}
        <Card>
          <CardHeader title="Recent closes" />
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th right>Opening</Th>
                <Th right>Expected</Th>
                <Th right>Counted</Th>
                <Th right>Over/short</Th>
                <Th>By</Th>
              </tr>
            </thead>
            <tbody>
              {history.map(({ d, by }) => (
                <tr key={d.id}>
                  <Td>
                    <Link className="hover:underline" href={`/admin/drawer?date=${d.businessDate}`}>
                      {formatDate(d.businessDate, "EEE MMM d")}
                    </Link>
                  </Td>
                  <Td right>{formatCents(d.openingFloatCents)}</Td>
                  <Td right>{formatCents(d.expectedCents)}</Td>
                  <Td right>{formatCents(d.countedCents ?? 0)}</Td>
                  <Td right className={(d.varianceCents ?? 0) < 0 ? "text-red-600" : (d.varianceCents ?? 0) > 0 ? "text-amber-700" : ""}>
                    {formatCents(d.varianceCents ?? 0, { sign: true })}
                  </Td>
                  <Td>{by ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "border-t border-zinc-200 pt-2 font-semibold" : ""}`}>
      <dt className="text-zinc-600">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
