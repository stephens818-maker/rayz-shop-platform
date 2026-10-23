import type { Metadata } from "next";
import { asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { shopPaymentAccounts, shops } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, Input, PageHeader, Select, Stat, Table, Td, Th, buttonClass } from "@/components/ui";
import { ACCOUNT_STATE_LABEL, PAYMENTS_MODE_LABEL, payoutScheduleLabel } from "@/domain/connect";
import { formatCents } from "@/lib/money";
import { addDays, todayLocal, type LocalDate } from "@/lib/time";
import { guardPage, reportShopIds } from "@/server/auth/staff";
import { payoutRows, shopAccountRows } from "@/server/payments/account-report";
import { brandPayoutSchedule } from "@/server/payments/connect";

export const metadata: Metadata = { title: "Payouts" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_TONE = { paid: "green", in_transit: "blue", pending: "amber", failed: "red", canceled: "gray" } as const;
const $ = (c: number | null) => (c == null ? "—" : formatCents(c));

export default async function PayoutsPage({ searchParams }: { searchParams: Promise<{ shop?: string; from?: string; to?: string }> }) {
  const ctx = await guardPage("/admin/payouts");
  const sp = await searchParams;
  const requested = sp.shop ?? (ctx.currentShopId ? ctx.currentShopId : "all");
  const shopIds = reportShopIds(ctx, requested);
  const to = (sp.to && DAY.test(sp.to) ? sp.to : todayLocal()) as LocalDate;
  const from = (sp.from && DAY.test(sp.from) && sp.from <= to ? sp.from : addDays(to, -30)) as LocalDate;
  const scope = { shopIds, from, to };
  const allShops = shopIds.length === ctx.shopIds.length;
  const withBrand = ctx.brandWide && allShops;
  const [accounts, payouts, names, schedules, brandSchedule] = await Promise.all([
    shopAccountRows(scope),
    payoutRows(scope, { brand: withBrand }),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, ctx.shopIds)).orderBy(asc(shops.name)),
    db.select({ shopId: shopPaymentAccounts.shopId, schedule: shopPaymentAccounts.payoutSchedule }).from(shopPaymentAccounts).where(inArray(shopPaymentAccounts.shopId, shopIds)),
    brandPayoutSchedule(),
  ]);
  const scheduleOf = (shopId: string) => schedules.find((s) => s.shopId === shopId)?.schedule ?? null;
  const own = accounts
    .filter((a) => a.paymentsMode === "connected" || a.stripeAccountId)
    .map((a) => {
      const cardCents = a.cardNetCents - a.brandSettledCents - a.unroutedCardCents;
      const feeCents = a.processingFeesCents - a.brandFeesCents;
      return { ...a, cardCents, feeCents, netCents: cardCents - feeCents };
    });
  const onBrand = accounts.filter((a) => a.paymentsMode === "brand" || a.brandSettledCents !== 0);
  const brandCard = onBrand.reduce((x, a) => x + a.brandSettledCents, 0);
  const brandFees = onBrand.reduce((x, a) => x + a.brandFeesCents, 0);
  const brandPayouts = payouts.filter((p) => p.shopId === null);
  const sum = (xs: { amountCents: number; status: string }[], st: string[]) => xs.filter((p) => st.includes(p.status)).reduce((a, p) => a + p.amountCents, 0);
  const paid = sum(payouts, ["paid"]);
  const transit = sum(payouts, ["pending", "in_transit"]);
  const failed = payouts.filter((p) => p.status === "failed");
  const fees = accounts.reduce((a, r) => a + r.processingFeesCents, 0);
  const refunds = accounts.reduce((a, r) => a + r.cardRefundsCents, 0);
  const card = accounts.reduce((a, r) => a + r.cardNetCents, 0);
  const label = shopIds.length === 1 ? (names.find((n) => n.id === shopIds[0])?.name ?? "This shop") : allShops ? "Every shop" : `${shopIds.length} shops`;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Payouts"
        subtitle={`${label}, ${from} to ${to}. Deposits Stripe made to each bank, what they're made of, and the processing fees. Shops on their own account are paid to their own bank; shops on the brand's account are paid together to the brand's.`}
      />
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="text-sm text-zinc-700">
          <span className="mb-1 block text-xs font-medium text-zinc-500">Shop</span>
          <Select name="shop" defaultValue={shopIds.length === 1 ? shopIds[0] : "all"} className="w-56">
            {ctx.shopIds.length > 1 && <option value="all">{ctx.brandWide ? "Every shop and the brand account" : "All my shops"}</option>}
            {names.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm text-zinc-700">
          <span className="mb-1 block text-xs font-medium text-zinc-500">Arriving from</span>
          <Input type="date" name="from" defaultValue={from} />
        </label>
        <label className="text-sm text-zinc-700">
          <span className="mb-1 block text-xs font-medium text-zinc-500">to</span>
          <Input type="date" name="to" defaultValue={to} />
        </label>
        <button type="submit" className={buttonClass("secondary")}>
          Show
        </button>
      </form>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Paid to banks" value={formatCents(paid)} hint={`${payouts.filter((p) => p.status === "paid").length} payouts`} />
        <Stat label="On the way" value={formatCents(transit)} hint={failed.length ? `${failed.length} failed` : "pending or in transit"} tone={failed.length ? "down" : undefined} />
        <Stat label="Processing fees" value={formatCents(fees)} hint={card ? `${((fees / card) * 100).toFixed(2)}% of ${formatCents(card)} card takings` : undefined} />
        <Stat label="Card refunds" value={formatCents(refunds)} />
      </div>

      <Card>
        <CardHeader title="By account" subtitle="Card takings are by business date, after refunds, with tips and surcharges. Payouts are by the day they reach the bank, so the two don't line up day for day." />
        <Table>
          <thead>
            <tr>
              <Th>Account</Th>
              <Th>Pays out to</Th>
              <Th>Schedule (from Stripe)</Th>
              <Th right>Card takings</Th>
              <Th right>Fees</Th>
              <Th right>To account</Th>
              <Th right>Paid out</Th>
              <Th right>On the way</Th>
            </tr>
          </thead>
          <tbody>
            {own.map((a) => {
              const mine = payouts.filter((p) => p.shopId === a.shopId);
              return (
                <tr key={a.shopId}>
                  <Td>
                    <div className="font-medium text-zinc-900">{a.shopName}</div>
                    <div className="text-xs text-zinc-500">
                      {a.stripeAccountId ? <code>{a.stripeAccountId}</code> : "No account yet"} · {ACCOUNT_STATE_LABEL[a.state]}
                      {a.paymentsMode !== "connected" && ` · now ${PAYMENTS_MODE_LABEL[a.paymentsMode].toLowerCase()}`}
                    </div>
                  </Td>
                  <Td className="text-zinc-600">{a.ownerName}&apos;s bank</Td>
                  <Td className="text-zinc-600">{payoutScheduleLabel(scheduleOf(a.shopId))}</Td>
                  <Td right>{$(a.cardCents)}</Td>
                  <Td right>{$(a.feeCents)}</Td>
                  <Td right>{$(a.netCents)}</Td>
                  <Td right>{$(sum(mine, ["paid"]))}</Td>
                  <Td right>{$(sum(mine, ["pending", "in_transit"]))}</Td>
                </tr>
              );
            })}
            {onBrand.length > 0 && (
              <tr className="bg-zinc-50/60">
                <Td>
                  <div className="font-medium text-zinc-900">Brand account</div>
                  <div className="text-xs text-zinc-500">{onBrand.map((a) => a.shopName).join(", ")}</div>
                </Td>
                <Td className="text-zinc-600">The brand&apos;s bank</Td>
                <Td className="text-zinc-600">{payoutScheduleLabel(brandSchedule)}</Td>
                <Td right>{$(brandCard)}</Td>
                <Td right>{$(brandFees)}</Td>
                <Td right>{$(brandCard - brandFees)}</Td>
                <Td right>{withBrand ? $(sum(brandPayouts, ["paid"])) : "—"}</Td>
                <Td right>{withBrand ? $(sum(brandPayouts, ["pending", "in_transit"])) : "—"}</Td>
              </tr>
            )}
          </tbody>
        </Table>
        {onBrand.length > 0 && !withBrand && (
          <p className="px-4 py-3 text-xs text-zinc-500">The brand account&apos;s deposits pool every shop on it, so they&apos;re shown only to people who see every shop, with every shop selected.</p>
        )}
      </Card>

      <Card>
        <CardHeader title="Payouts" subtitle="Each deposit, itemized from Stripe's balance transactions: gross card charges, the fees taken, and refunds netted out." />
        {payouts.length === 0 ? (
          <Empty title="No payouts arriving in these dates" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Arrives</Th>
                <Th>Account</Th>
                <Th>Payout</Th>
                <Th>Status</Th>
                <Th right>Gross</Th>
                <Th right>Fees</Th>
                <Th right>Refunds</Th>
                <Th right>Net deposit</Th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.stripePayoutId}>
                  <Td>{p.arrivalDate}</Td>
                  <Td>{p.shopName}</Td>
                  <Td>
                    <code className="text-xs text-zinc-600">{p.stripePayoutId}</code>
                    {p.itemCount != null && <span className="ml-2 text-xs text-zinc-400">{p.itemCount} items</span>}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[p.status as keyof typeof STATUS_TONE] ?? "gray"}>{p.status.replace("_", " ")}</Badge>
                    {p.failureMessage && <div className="mt-1 text-xs text-red-700">{p.failureMessage}</div>}
                  </Td>
                  <Td right>{$(p.grossCents)}</Td>
                  <Td right>{p.feeCents == null ? "—" : formatCents(-p.feeCents)}</Td>
                  <Td right>{p.refundCents == null ? "—" : formatCents(-p.refundCents)}</Td>
                  <Td right className="font-medium">
                    {formatCents(p.amountCents)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
